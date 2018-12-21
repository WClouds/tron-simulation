const mongoose = require('mongoose');
const _ = require('lodash')
const Moment = require('moment-timezone');
const data = require('./data');
const redis = require('./redis');
const { handleDropoffPenaltyInput, handleDropoffPenaltyOutput } = require('./util')
const { accountModel, orderModel } = require('./connection');
const tronClient = require('./tronClient');
const { updateTron,updateStop } = require('./update');

const TRON_HOSTNAME = 'http://localhost:5000'



class Processor {
  constructor() {
  }

  async init() {
    const {
      accounts,
      orders,
      region
    } = await data.init();
    this.accounts = accounts;
    this.orders = orders;
    this.tronOptions = _.get(region, 'tron.options')
    

    await accountModel.deleteMany();
    await accountModel.insertMany(this.accounts)
    await orderModel.deleteMany();
    await orderModel.insertMany(this.orders);
    await orderModel.updateMany({$set:{'delivery.status':'confirmed'}});

    console.log('init data success');


  }

  async constructFleet(time) {
    let drivers = await accountModel.find();
    drivers = _.filter(drivers, driver => {

      /* onCall filter */
      let onCall = false;
      _.forEach(driver.shifts, shift => {
        if (time >= Moment(shift.start).unix() && time <= Moment(shift.end).unix()) {
          onCall = true;
          driver.onCall = true;
        }
      })
      return onCall || _.get(driver, 'stops.next');
    })

    /* Convert to fleet */
    const fleet = _.reduce(drivers, (f, d) => {

      /* init driver start time */
      d.start = time;

      /* Use next stop as driver start location if has one */
      const next = _.get(d, 'stops.next');

      /* If there's next stop */
      if (next) {
        d.location = next.address.location;

        /* Use the finish time as the start time, */
        d.start = next.finishAt;

        /* if current time already larger than finish time */
        /* use the current time + 5 min if not arrived */
        /* use the current time + 2 min if already arrived */
        const late = Moment().add(next.arrivedAt ? 2 : 5, 'minute').toDate();

        /* Assign late time to new current time*/
        if (late > d.start) {
          d.start = late;
        }
      }

      /* Decide Type */
      /* Can take new orders if online, can only take en-route order if offline */
      const type = [d._id.toString()];

      if (d.onCall) {
        type.push('all');
      }

      /* Build the driver starting object */
      const fl = {
        type,
        start_location: {
          name: d.email,
          lat: _.get(d, 'location.coordinates[1]'),
          lng: _.get(d, 'location.coordinates[0]')
        },
        shift_start: Moment(d.start).unix()

      };

      /* Assign */
      _.set(f, d._id, fl);

      return f;
    }, {});


    /* Throw Error if no driver */
    if (_.isEmpty(fleet)) {
      throw new Error('No couriers available at this time');
    }
    return fleet;
  }

  async constructVisits(time) {
    query = {

      /* Delivery must exists */
      'delivery._id': {
        $ne: null
      },

      /* Must not be delivered or failed */
      'delivery.status': {
        $nin: ['completed', 'failed']
      },

      /* Must not be delivered */
      'delivery.time': null,

      /* Must be confirmed */
      status: 'confirmed',

    };

    const orders = await orderModel.find(query);

    /* Convert to visists */
    const visits = _.reduce(orders, (v, o) => {

      /* Get restaurant prepare time, default 15 min */
      const prepare = _.get(o, 'restaurant.delivery.prepare') || 15;
      const pickup = {
        location: {
          name: `PICKUP#${o.passcode}`,
          lat:  _.get(o, 'restaurant.address.location.coordinates[1]'),
          lng:  _.get(o, 'restaurant.address.location.coordinates[0]')
        },
        start:    Moment(o.createdAt).add(prepare, 'minutes').unix(),
        duration: 4
      };

      /* Create the dropoff time */
      /* Init estimate time with min */
      /*
      let est = 45 - (region.restriction || 10);
      */

      /* init the estimated time of arrival as 45 minutes */
      let est = 45;

      /**
       * New customer get higher priority about 5 minutes
       */
      if (_.get(o, 'customer.orderCount') === 0) {
        est -= 5;
      }

      /* Make sure the EST is technically possible, otherwise routific will reject */
      /* Est is cannot be less than (prepare + 15) minutes */
      /* 15 = pickup duration (5) + dropoff duration (5) + en route (5) */
      est = _.max([ est, prepare + 15 ]);

      /* Create dropoff object */
      const dropoff = {
        location: {
          name: `DROPOFF#${o.passcode}`,
          lat:  _.get(o, 'delivery.address.location.coordinates[1]'),
          lng:  _.get(o, 'delivery.address.location.coordinates[0]')
        },
        end:      Moment(o.createdAt).add(est, 'minutes').unix(),
        duration: 2
      };

      /* Can be delivered by all driver as default */
      let type = 'all';

      /* If driver already assigned, lock to that driver */
      if (_.get(o, 'delivery.courier._id')) {

        /* set type to the driver id, so that only the current driver can deliver it */
        type = o.delivery.courier._id.toString();
      }


      /* Special casese */
      const status = _.get(o, 'delivery.status');

      /* Driver en route to pickup, */
      /* Restrict the type of this order to driver id */
      if (/pickup/.test(status)) {

        /* Throw error if no specific driver working on this order */
        if (type === 'all') {
          throw new Error(`Order #${o.passcode} is ${status} but has no driver`);
        }

        /* set pickup location to be same as dropoff location, and duration to be 1 */
        /* and name to be 'ignore' so it's easy to identify later */
        pickup.location = {
          lat:  dropoff.location.lat,
          lng:  dropoff.location.lng,
          name: 'ignore'
        };
        pickup.duration = 1;
        delete pickup.start;
      }

      /* Driver en route to dropoff, skip this order */
      if (/dropoff/.test(status)) {

        /* Throw error if no specific driver working on this order */
        if (type === 'all') {
          throw new Error(`Order #${o.passcode} is ${status} but has no driver`);
        }

        return v;
      }

      /* Add the visit object, skip if too much orders */
      if (o.delivery.courier || _.size(v) <= 80) {
        _.set(v, o._id, { load: 1, pickup, dropoff, type });
      }

      return v;

    }, {});


    /* Skip the routific call if no orders to deliver */
    if (_.isEmpty(visits)) {
      throw new Error('No more deliveries to plan');
    }

    return visits;

  }


  async runTron(time) {
    const fleet = await this.constructFleet(time);
    const visits = await this.constructVisits(time);
    const options = {
      lateness_penalty:                 _.get(this.tronOptions, 'lateness_penalty') || 15,
      duration_coefficient:             _.get(this.tronOptions, 'duration_coefficient') || 1,
      map:                              _.get(this.tronOptions, 'map'), // Map data tag
      open_pickup_late_penalty:         _.get(this.tronOptions, 'open_pickup_late_penalty') || false,
      open_dropoff_multi_level_penalty: _.get(this.tronOptions, 'open_dropoff_multi_level_penalty') || false,
      dropoff_multi_level_penalty:      {

        /* default is 15minutes as a level */
        split_minute:        _.get(this.tronOptions, 'dropoff_multi_level_penalty.split_minute') || 15,

        /* penalty coefficient, default is 1 */
        penalty_coefficient: _.get(this.tronOptions, 'dropoff_multi_level_penalty.penalty_coefficient') || 1
      }
    };

    const {input, subTime} = handleDropoffPenaltyInput({ fleet, visits, options })
    const res = await tronClient(input)
    return handleDropoffPenaltyOutput(res.output)
  }

  async start(){

    const orders = await orderModel.find();
      
    const length = orders.length;

    let i = 0;

    while(i<=length){

      const order = orders[i];

      const createdAt = _.get(order,'createdAt');

      //run tron
      const tronResult = this.runTron(createdAt);

      //after run tron update data
      await updateTron(tronResult);

      const estimatedTime = _.get(tronResult,'estimatedTime');

      //between estimated time and this order create time
      //account login , run tron & create stop
      const loginArray = await this.accountOnline(createdAt,estimatedTime);

      const ordersArray = await this.betweenOrders(createdAt,estimatedTime);

      const statusArray = await this.accountStatus();

      if(loginArray.length>0&&ordersArray.length>0&&statusArray.length>0){

        _.forEach(loginArray,(accountItem)=>{

        })
      }else if(loginArray.length>0&&ordersArray.length===0&&statusArray.length>0){

      }else if(loginArray.length>0&&ordersArray.length===0&&statusArray.length===0){

      }else if(loginArray.length>0&&ordersArray.length>0&&statusArray.length===0){

      }else if(loginArray.length===0&&ordersArray.length>0&&statusArray.length>0){

      }else if(loginArray.length===0&&ordersArray.length===0&&statusArray.length>0){

      }else if(loginArray.length===0&&ordersArray.length>0&&statusArray.length===0){

      }else if(loginArray.length===0&&ordersArray.length===0&&statusArray.length===0){
        i++;
      }

       
    }
    
        
  }

  compareTime(start,end,time){

  }

  async accountOnline(createdAt,estimatedTime){

    const accounts = await accountModel.find();

    let accountArray = [];
    let time;
    _.forEach(accounts,(account)=>{

      _.forEach(_.get(account,'shifts'),(shift)=>{

        if(this.compareTime(createdAt,estimatedTime,_.get(shift,'start'))){
          //if account login 
          accountArray.push(account);
  
        }
      })
        
    })

    return _.sortBy(accounts,'');

  }

  async betweenOrders(createdAt,estimatedTime){

    return await orderModel.find({createdAt:{"gt":createdAt,"lt":estimatedTime}}).sort({'createdAt':1});

  }


  async accountStatus(start,end){

    return await accountModel.find({$and:[
      {'stops.next.status':/at-pickup|pickup-complete|at-dropoff|delivered/},
      {createdAt:{"gt":start,"lt":end}}
    ]});

  }

}

processor = new Processor()

processor.init()
  .then((data) => {
    
    mongoose.disconnect()
  })
  .catch(err => {
    console.log(err);
    mongoose.disconnect()
  })