const mongoose = require('mongoose');
const _ = require('lodash')
const Moment = require('moment-timezone');
const data = require('./data');
const redis = require('./redis');
const { handleDropoffPenaltyInput, handleDropoffPenaltyOutput } = require('./util')
const { accountModel, orderModel } = require('./connection');
const tronClient = require('./tronClient');
const { updateTron,updateStop,createStop } = require('./update');

process.on('unhandledRejection', (reason, p) => {
  console.log('Unhandled Rejection at:', p, 'reason:', reason);
  // Application specific logging, throwing an error, or other logic here
});


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
    this.tronOptions = _.get(region, 'tron.options');
    this.statusArr = ['en-route-to-pickup','at-pickup','pickup-completed','en-route-to-dropoff','at-dropoff','completed'];
    this.type;
    this.accountId;
    this.driverArr = await this.dirverStartOrEnd();
    this.tronResult;
    

    await accountModel.deleteMany();
    await accountModel.insertMany(this.accounts)


    console.log('init data success');

  }

  async constructFleet(time) {

    let drivers = await accountModel.find();
    
    drivers = _.filter(drivers, driver => {

      /* onCall filter */
      let onCall = false;
      _.forEach(driver.shifts, shift => {


        if (Moment(time).unix() >= Moment(shift.start).unix() && Moment(time).unix() < Moment(shift.end).unix()) {
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
    const query = {

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

    const {input, subTime} = handleDropoffPenaltyInput({ fleet, visits, options, time })
  
    const res = await tronClient(input)
    return handleDropoffPenaltyOutput(res.output, subTime)
  }

  async start(){

    await orderModel.deleteMany();

    await this.firstRun(this.orders[0]);

    let deliveringOrderLength = (await this.queryDeliveringOrders()).length

    let runTron = this.orders.length > 0 || deliveringOrderLength > 0

    while(runTron){

        await this.run();
        deliveringOrderLength = (await this.queryDeliveringOrders()).length;

        console.log('run done once');
      
    }

    
    console.log('done');
  }

  async queryDeliveringOrders(){

    const query = {

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

    return await orderModel.find(query).lean();

  }

  async insertOrder(order) {

    order.delivery.courier = null;
    order.delivery.status = null;
    order.delivery.createdAt = null;
    order.delivery.quote = null;
    order.delivery.time = null;
    order.status = 'confirmed';

    await orderModel.create(order);
    this.orders.shift()
  }


  async firstRun(order){

    const createdAt = _.get(order,'createdAt');


    await this.insertOrder(order);

    const tronResult = await this.runTron(createdAt);

    this.tronResult = tronResult;

    // 排过序最早的est时间
    /*
    [
      {
        type: 'pickup arrived...',
        time: arrival/finish
      }
    ]
    */
   await updateTron(_.cloneDeep(tronResult));

   await this.dealTronResult(_.cloneDeep(tronResult));

   await this.updateAllStops();
  
    
  }

  async run(){

    const arr = _.cloneDeep(this.driverArr);

    const { type, time , accountId } = await this.dealTronResult(_.cloneDeep(this.tronResult));
    
    if(this.orders.length > 0){

      const nextOrder = this.orders[0];

      const nextCreatedAt = _.get(nextOrder,'createdAt');

      arr.push({point:nextCreatedAt,type:'nextOrder'});
    }
    
    arr.push({point:time,type:'estimatedTime'});

    const afterSort = _.sortBy(arr,'point');    

    const item = _.head(afterSort);

    const itemType = _.get(item,'type');

    let tronResult ;
    // dirver start or end
    if(itemType === 'staff'){

      tronResult = await this.runTron(_.get(item,'point'));

      await updateTron(_.cloneDeep(tronResult));

      await this.updateAllStops();

      this.tronResult = tronResult;

    
      this.driverArr.shift();

    }else if(itemType === 'estimatedTime'){

      console.log('estimatedTime');
      // pickup arrived
      // pickup completed
      // dropoff arrived
      // dropoff completed
      await updateStop({id: accountId, body:await this.updateStopData(type)});

      tronResult = await this.runTron(_.get(item,'point'));

      this.tronResult = tronResult;

      await updateTron(_.cloneDeep(tronResult));

      await this.updateAllStops();
  
    }else if(itemType === 'nextOrder'){

      await this.insertOrder(this.orders[0])

      const createdAt = this.orders[0].createdAt;

      tronResult = await this.runTron(createdAt);

      this.tronResult = tronResult;

      await updateTron(_.cloneDeep(tronResult))
   
      await this.updateAllStops();

    }


  }

  async updateStopData(type){

    return{
      status:type,
      reason:'',
      description:''
    }
  }

  async dealTronResult(tronResult){

    const solution = _.get(tronResult,'solution');


    const arr = [];

    _.forEach(solution,(v,k)=>{

      v.shift();

      _.forEach(v,(item)=>{

        arr.push({...item,accountId:k})
      })
    });

    //sort by arrived time
    const afterGroupArr = _.groupBy(arr,'location_id');


    const atferMap =await Promise.all(_.map(afterGroupArr,async (v,k)=>{

      const itemOrder = await orderModel.findOne({_id:k});

      const nextStatus =await this.dealDeliveryStatus(itemOrder.delivery.status)

      let time;
      switch (nextStatus) {
        case 'en-route-to-pickup':
        case 'at-pickup': {
          time = (_.filter(v, ['type', 'pickup']))[0].arrival_time;
          break;
        }
        case 'pickup-completed':
          time = (_.filter(v, ['type', 'pickup']))[0].finish_time;break;
        case 'en-route-to-dropoff':
        case 'at-dropoff':
          time = (_.filter(v, ['type', 'dropoff']))[0].arrival_time;break;
        case 'completed':
          time = (_.filter(v, ['type', 'dropoff']))[0].finish_time;break;
      }

      return {time,orderId:k,nextStatus,accountId:v[0].accountId}      
    }))


    _.sortBy(atferMap,'time');

    const top = _.head(atferMap);


    return {
      accountId:top.accountId,
      type:top.nextStatus,
      time:top.time
    }

    
  }

  dealDeliveryStatus(status){

  
    const index = _.indexOf(this.statusArr,status);


    return this.statusArr[index+1];

  }


  async dirverStartOrEnd(){

    const arr = [];

    // _.forEach(this.accounts,(account)=>{

    //   const shifts = _.get(account,'shifts');

    //   _.forEach(shifts,(shift)=>{

    //     const start = _.get(shift,'start');

    //     const end = _.get(shift,'end');
      
    //     if(Moment(start).unix()>=(Moment(time).unix())){

    //       account.point = start;
    //       arr.push(account);
    //       return false;
    //     }else if(Moment(end).unix()>=(Moment(time).unix())){

    //       account.point = end;
    //       arr.push(account);
    //       return false;
    //     }
    //   })
    // })

    _.forEach(this.accounts,(account)=>{

      const shifts = _.get(account,'shifts');

      _.forEach(shifts,(shift)=>{

        const start = _.get(shift,'start');

        const end = _.get(shift,'end');
      
        arr.push({...account,time:start,flag:'start'});
        arr.push({...account,time:end,flag:'end'});
      })
    })

    return _.sortBy(arr,'time');
  }

  async updateAllStops(){


    const result = await accountModel.find().lean();

    await Promise.all(_.map(result,async (item)=>{

      if(!item.stops.next&&item.stops.route.length>0){

        await createStop({id:item._id});
      }
    }))
  }
  

}

processor = new Processor()

processor.init()
  .then(async() => {
    await processor.start();
    mongoose.disconnect()
  })
  .catch(err => {
    console.log(err);
    mongoose.disconnect()
  })