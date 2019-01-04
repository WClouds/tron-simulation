const mongoose = require('mongoose');
const _ = require('lodash')
const Moment = require('moment-timezone');
const data = require('./data');
const redis = require('./redis');
const { handleDropoffPenaltyInput, handleDropoffPenaltyOutput } = require('./util')
const { accountModel, orderModel,eventModel } = require('./connection');
const tronClient = require('./tronClient');
const { updateTron,updateStop,createStop } = require('./update');
const { eventCreate } = require('./data/event');
const { accountFind,accountUpdate,accountList } = require('./data/account');

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
    this.estStatusArr = ['en-route-to-pickup','at-pickup','pickup-completed'];
    // this.estStatusArr = ['en-route-to-pickup','at-pickup','pickup-completed','en-route-to-dropoff','at-dropoff','completed'];
    this.currentDeliveryStatus = ['en-route-to-pickup','at-pickup','pickup-completed']
    // this.currentDeliveryStatus = ['en-route-to-pickup','at-pickup','pickup-completed','en-route-to-dropoff','at-dropoff']
    this.type;
    this.accountId;
    this.driverArr = await this.dirverStartOrEnd();
    this.tronResult;
    

    await accountModel.deleteMany();
    
    console.log('clear account success');
    await eventModel.deleteMany();

    console.log('clear event success');
    await orderModel.deleteMany();

    console.log('clear order success');
    await accountModel.insertMany(this.accounts)

    console.log('insert origin data success');


    console.log('init data success');

  }

  async constructFleet(time) {

    const drivers = await this.getOnlineDrivers(time);

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
        // const late = Moment(time).add(next.arrivedAt ? 2 : 5, 'minute').toDate();

        // /* Assign late time to new current time*/
        // if (late > d.start) {
        //   d.start = late;
        // }
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
        shift_start: Moment(d.start).unix(),
        unskilled: d.unskilled ? true : false

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

  async getOnlineDrivers(time){

    if (_.isNumber(time)) {
      if (time.toString().length === 10) {
        time = Moment(time * 1000).toDate()
      } else {
        time = Moment(time).toDate()
      }
    }

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

    return drivers;
  }


  async runTron(time) {

    try {
      if (_.isNumber(time)) {
        if (time.toString().length === 10) {
          time = Moment(time * 1000).toDate()
        } else {
          time = Moment(time).toDate()
        }
      } else {
        time = Moment(time).toDate()
      }
  
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
        },
        unskilled_penalty: {
          open: true,
          penalty_coefficient: 2
        }
      };

      const backFleet = _.cloneDeep(fleet)
      const backVisits = _.cloneDeep(visits)
  
      const {input, subTime} = handleDropoffPenaltyInput({ fleet, visits, options, time })
    
      const res = await tronClient(input)
      
      eventCreate( {
        data:  { tron: res, input: { visits: backVisits, fleet: backFleet, options }, runAt: time },
        name:  'tron.output',
  
      });
      
  
  
      return handleDropoffPenaltyOutput(res.output, subTime)
    } catch (err) {
      console.log('run tron error====>', err)
      return { output: err.message, status: 'error' }
    }

  }

  async start(){

    console.log('===============start=================');

    await orderModel.deleteMany();

    // await this.firstRun(this.orders[0]);

    let deliveringOrderLength = (await this.queryDeliveringOrders()).length

    let runTron = this.orders.length > 0 || deliveringOrderLength > 0

    while(runTron){

        await this.run();
        deliveringOrderLength = (await this.queryDeliveringOrders()).length;

        runTron = this.orders.length > 0 || deliveringOrderLength > 0

        if (_.get(this.tronResult, 'unserved')) {
          console.log('this.tron.output--->', this.tronResult);
          process.exit(1)
        }

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


  // async firstRun(order){

  //   // init order
  //   const createdAt = _.get(order,'createdAt');

  //   await this.insertOrder(order);

  //   console.log('insert success');

  //   const tronResult = await this.runTron(createdAt);

  //   this.tronResult = tronResult;

  //   // 排过序最早的est时间
  //   /*
  //   [
  //     {
  //       type: 'pickup arrived...',
  //       time: arrival/finish
  //     }
  //   ]
  //   */
  //  await updateTron(_.cloneDeep(tronResult));

  //  await this.createAllStops(createdAt);

  //  console.log('first run success');

  // }
  
  async run(){
    
    // get driver online/offline time list
    let arr = _.cloneDeep(this.driverArr);

    // TODO
    // get driver scheudledAt time list
    const scheduledAccounts = await accountModel.find({'stops.scheduledAt': {$exists: true, $ne: null}});

    const mapScheduledAccounts = _.map(scheduledAccounts,(item)=>{

      return {point:item.stops.scheduledAt,type:'driverScheduledAt',accountId:item._id, next: item.stops.next}
    })

    
    arr = arr.concat(mapScheduledAccounts);
    
    // get order status change estimate time
    const estResult = await this.getEstOrder(_.cloneDeep(this.tronResult));

    let { type, time , accountId, orderId } = estResult ? estResult : {}
    arr.push({point:time,type:'estimatedTime', orderId});
  
    // get next created order time
    if(this.orders.length >= 1){
      
      const nextOrder = this.orders[0];
      
      const nextCreatedAt = _.get(nextOrder,'createdAt');
      
      arr.push({
        point:Moment(nextCreatedAt).unix(),
        type:'nextOrder',
        orderId: nextOrder._id
      });
    }
    
    const afterSort = _.sortBy(arr,'point');    

    const item = _.head(afterSort);

    const itemType = _.get(item,'type');

    let tronResult ;

    if (item.type === 'estimatedTime') {
      console.log('item===>', item.orderId, item.type, item.point, Moment(item.point * 1000).toDate())
    } else {
      console.log('item===>', item.type, item.point, Moment(item.point * 1000).toDate())
    }

    // dirver start or end
    if(itemType === 'staff'){

      console.log(`staff status : ${_.get(item,'flag')} id : ${_.get(item,'_id')}`);

      tronResult = await this.runTron(_.get(item,'point'));

      await updateTron(_.cloneDeep(tronResult));

      await this.createAllStops(_.get(item,'point'));

      this.tronResult = tronResult;
    
      this.driverArr.shift();

    } else if (itemType === 'driverScheduledAt') {

      console.log('driver scheduledat==>')
      let toUpdateBody;
      let scheduledAt;
      /**
       * dropoff completed
       */
      if (item.next.arrivedAt) {
        console.log('scheduledat dropoff completed==>')
        toUpdateBody = await this.getUpdateStopData('completed')
        /* clear scheduledAt */
        scheduledAt = null;
      } else {
        console.log('scheduledat at-dropoff==>')
        toUpdateBody = await this.getUpdateStopData('at-dropoff')

        /* set scheduledAt time as dropoff completed time */
        scheduledAt = item.next.finish_time;
      }
      console.log('scheduledAt=-=>', item.accountId, scheduledAt);
      await accountUpdate({
        id: item.accountId,
        data: {
          $set: {
            'stops.scheduledAt': scheduledAt
          }
        }
      })
      await updateStop({
        id: item.accountId,
        body:toUpdateBody,
        time: _.get(item,'point')
      });


      // runTron
      tronResult = await this.runTron(_.get(item,'point'));
      this.tronResult = tronResult;
      // updateTron
      await updateTron(_.cloneDeep(tronResult));
      await this.createAllStops(_.get(item,'point'));



    }else if(itemType === 'estimatedTime'){

      console.log('estimatedTime');

      const toUpdateBody = await this.getUpdateStopData(type)
      // pickup arrived
      // pickup completed
      // dropoff arrived
      // dropoff completed
      await updateStop({
        id: accountId,
        body: toUpdateBody,
        time: _.get(item,'point')
      });

      const nextStatus = toUpdateBody.status;

      if (nextStatus === 'completed') {

        /*
        * if next status is completed, it means driver next is null
        * so we need assign new order first
        * then run tron
        */
        await this.createAllStops(time);
      } else {

        // if next status is at-dropoff
        // save scheduledAt time as a time point to run Tron and set order.delivery.status to completed
        // if (type === 'at-dropoff') {
        //   const scheduledAt = (_.find(this.tronResult.solution[accountId],{'location_id':orderId,type:'dropoff'})).finish_time;
        //   console.log('in at-dropoff====>', typeof accountId, accountId, orderId, scheduledAt);

        //   await accountUpdate({
        //     id: accountId,
        //     data: {
        //       $set: {
        //         'stops.scheduledAt': scheduledAt
        //       }
        //     }
        //   })

        // }

        tronResult = await this.runTron(_.get(item,'point'));
        this.tronResult = tronResult;
        await updateTron(_.cloneDeep(tronResult));
        await this.createAllStops(time);
      }



    }else if(itemType === 'nextOrder'){

      console.log('nextOrder', item.orderId);

      const createdAt = this.orders[0].createdAt;

      await this.insertOrder(this.orders[0])

      tronResult = await this.runTron(createdAt);

      this.tronResult = tronResult;

      await updateTron(_.cloneDeep(tronResult))

      await this.createAllStops(createdAt);

    }


  }

  async getUpdateStopData(type){

    if(!_.includes(['at-pickup','at-dropoff','pickup-completed','completed'],type)){

      throw new Error(`update stop need one of these status: "at-pickup","pickup-completed","at-dropoff","completed" , current status : ${type}`);
    }

    let status = type === 'at-pickup' || type === 'at-dropoff'?'arrived':'completed';
    
    return{
      status,
      reason:'',
      description:''
    }
  }

  async getEstOrder(tronResult){

    const solution = _.get(tronResult,'solution');

    const arr = [];

    _.forEach(solution,(v,k)=>{

      // first item is driver est, remove it
      v.shift();

      _.forEach(v,(item)=>{

        arr.push({...item,accountId:k})
      })
    });

    // group by orderId
    const afterGroupArr = _.groupBy(arr,'location_id');
    const afterGroupOrderIds = Object.keys(afterGroupArr);

    const deliveringOrders = await this.queryDeliveringOrders();
    const filterdOrderIds = _.chain(deliveringOrders)
      .filter((order) => {
        return _.includes(afterGroupOrderIds, order._id) &&
          _.includes(this.currentDeliveryStatus, order.delivery.status);
      })
      .map(order => (order._id))
      .value()

    const filterDeliveringOrders = {}
    _.forEach(filterdOrderIds, orderId => {
      if (afterGroupArr[orderId]) {
        filterDeliveringOrders[orderId] = afterGroupArr[orderId]
      }
    })
   
      let atferMap =await Promise.all(_.map(filterDeliveringOrders,async (v,k)=>{

        const itemOrder = await orderModel.findOne({_id:k});

  
        const nextStatus =await this.dealDeliveryStatus(itemOrder.delivery.status);

  
        let time;
        switch (nextStatus) {
          // case 'en-route-to-pickup':
          case 'at-pickup': {
            time = (_.filter(v, ['type', 'pickup']))[0].arrival_time;
            break;
          }
          case 'pickup-completed':
            time = (_.filter(v, ['type', 'pickup']))[0].finish_time;break;
          // case 'en-route-to-dropoff':
          // case 'at-dropoff':
          //   time = (_.filter(v, ['type', 'dropoff']))[0].arrival_time;break;
          // case 'completed':
          //   time = (_.filter(v, ['type', 'dropoff']))[0].finish_time;break;
          default:
            console.log('error next status====>', k, nextStatus);
            break;
        }
  
        return {time,orderId:k,nextStatus,accountId:v[0].accountId}  
      }))

      atferMap = _.sortBy(atferMap,'time');
  
      const top = _.head(atferMap);


      if (top) {
        console.log('next Status===>', top.orderId, top.nextStatus, Moment(top.time * 1000).toDate())
        return {
          accountId:top.accountId,
          type:top.nextStatus,
          time:top.time,
          orderId: top.orderId
        }
      }
      return null;
    
  }

  dealDeliveryStatus(status){

    const index = _.indexOf(this.estStatusArr,status);

    return this.estStatusArr[index+1];

  }


  async dirverStartOrEnd(){

    const arr = [];

    _.forEach(this.accounts,(account)=>{

      const shifts = _.get(account,'shifts');

      _.forEach(shifts,(shift)=>{

        const start = _.get(shift,'start');

        const end = _.get(shift,'end');
      
        arr.push({...account,point:Moment(start).unix(),flag:'start'});
        arr.push({...account,point:Moment(end).unix(),flag:'end'});
      })
    })


    return _.sortBy(arr,'point');
  }

  async createAllStops(time){

    // only update online drivers because tron will filter with onCall and next !== null
    // const drivers = await this.getOnlineDrivers(time);
    const drivers = await accountModel.find();

    await Promise.all(_.map(drivers,async (item)=>{

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

module.exports = Processor
