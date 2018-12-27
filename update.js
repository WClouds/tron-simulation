const _            = require('lodash');
const Moment       = require('moment-timezone');
const redis = require('./redis');

const { accountModel, orderModel,regionModel } = require('./connection');
const tronClient = require('./tronClient');

const { canon } = require('./utils/uid');
const { fee } = require('./util');

const computeDistribution = require('./utils/compute-distribution');
const SortStops    = require('./utils/sort-stops');
const AdjStops  = require('./utils/adjust-stops');
const { addWeek, subtractWeek, timeout } = require('./utils/calculate-week');

const { accountFind,accountUpdate,accountList } = require('./data/account');
const { orderFind, orderUpdate,orderList } = require('./data/order');
const { regionFind } = require('./data/region');
const { shiftList } = require('./data/shift');
const { restaurantFind } = require('./data/restaurant');
const { eventCreate } = require('./data/event');


async function updateTron(route){


  /* Key / Value Format is hard to loop, so change to all value */
  const solution = _.map(route.solution, (stops, driver) => ({ stops, driver }));

  /* Mark if any driver with no stops, need to rerun tron with more restriction if necessary */
  let freeDriver = false;

  /* Iterate through solution */
  for (const { stops, driver } of solution) {

    /* Get account info */
    let account = await  accountFind({ id: driver });

    /* Get the start time of origin stop */
    const start = _.head(stops);
    const startAt = Moment.unix(start.arrival_time).toDate();


    /* Remove the first start location (no type) */
    /* Remove 'ignore' stop (ie: pickup stop supposed to be a dropoff) */
    _.remove(stops, s => !s.type || s.location_name === 'ignore');

    /* Normalize data for each stop */
    for (const s of stops) {

      /* Get relevant order */
      const o = await orderFind({ id: s.location_id });

      /* Update order if stop.type is dropoff */
      if (s.type === 'dropoff') {

        /* Update drlivery.finishAt */
        const data = { $set: { 'delivery.finishAt': Moment.unix(s.finish_time).toDate() } };

        /* Update order delivery status to scheduled if it was in processing  */
        if (!o.delivery.status || /processing|scheduled/.test(o.delivery.status)) {
          data.$set['delivery.status'] = 'scheduled';
        }

        /* Update order */
        await orderUpdate( {id:    o._id,data});
      }

      /* Keep: distance / type / arrive_time / finish_time */
      /* Meter => Mile */
      s.distance = Number((s.distance / 1600).toFixed(1));

      /* Convert arrival / fininsh time / estimate time */
      s.arriveAt = Moment.unix(s.arrival_time).toDate();
      s.finishAt = Moment.unix(s.finish_time).toDate();
      s.estimateAt = Moment(o.createdAt)
        .add(s.type === 'pickup' ? 15 : o.delivery.estimate.max, 'minutes')
        .toDate();

      /* Add: passcode / gps / address / phone / rest name / items */
      /* Destination Info */
      s.address = s.type === 'pickup' ? o.restaurant.address : o.delivery.address;
      s.phone   = s.type === 'pickup' ? o.restaurant.phone : o.customer.phone;

      /* Order Info */
      const fields = [
        '_id', 'passcode', 'createdAt', 'region',
        'restaurant.name', 'restaurant._id', 'restaurant.delivery.prepare'
      ];

      s.order = _.pick(o, fields);
      s.order.items = _.map(o.items, 'name.en-US');

    }

    /* Sort the order of pickup with same restaurnat by time */

    const sortStops = SortStops.sort(stops);


    /* Save route to driver */
    account = await accountUpdate({
      id:   driver,
      data: {
        $set: {

        /* This whole route is valid only when driver start on time */
        /* So need to mark the planned start time */
        /* In case driver's not on time, we can update the route accordingly */
          'stops.startAt':  startAt,
          'stops.route':    sortStops,
          'stops.polyline': _.get(route, `polylines.${driver}[0]`)
        }
      }
    });


    /* If driver is onCall and has no order in routes, set freeDriver to true */
    if (account.onCall && _.isEmpty(account.stops.route)) {
      freeDriver = true;
    }

  }

  /* return status of free driver */
  return freeDriver;
}

async function updateStop({id, body, time}){
  /**
   * Find the account in question
   */

  if (_.isNumber(time)) {
    if (time.toString().length === 10) {
      time = Moment(time * 1000).toDate()
    } else {
      time = Moment(time).toDate()
    }
  } else {
    time = Moment(time).toDate()
  }

   console.log('body===>',body);

  const account = await accountFind({ id });

  /* account is required */
  if (!account) {
    throw new Error('no account');
  }

  /* Get the current destination, and route */
  const stops = _.get(account, 'stops');
  const next  = _.get(stops, 'next');
  const route = _.get(stops, 'route');

  /* If driver has no existing stop. return error */
  if (!next) {
    throw new Error('driver has no existing stop');
  }

  /* Initialize diff and status */
  let diff;
  let status;

  /* Arrived Stop */
  if (body.status === 'arrived') {

    /* Prevent double arrive at the same stop */
    if (next.arrivedAt) {
      throw new Error('Already arrived at this stop');
    }

    /* Update the stop arrivedAt time & Calculate diff with estimate time */
    next.arrivedAt = time;
    diff = Moment(time).diff(next.arriveAt, 'minute');
    status = `at-${next.type}`;
  }

  /* Complete the stop */
  if (body.status === 'completed') {

    /* Prevent double complete at the same stop */
    if (!next.arrivedAt) {
      throw new Error('Cannot complete the stop before arriving');
    }

    /* Update the stop finishedAt time & Calculate diff with estimate time */
    next.finishedAt = time;
    diff = Moment(time).diff(next.finishAt, 'minute');
    status = next.type === 'pickup' ? 'pickup-completed' : 'completed';

    /* remove the next from stop */
    stops.next = null;
  }

  /* Failed the stop */
  if (body.status === 'failed') {

    /* Update the stop finishedAt time & Calculate diff with estimate time */
    diff = Moment(time).diff(next.finishAt, 'minute');
    status = 'failed';

    /* remove the next from stop */
    stops.next = null;

    /* Remove the all stop from the route */
    stops.route = [];
    stops.alert = 0;

  }

  /* Update order delivery status */
  const update = { $set: { 'delivery.status': status } };

  /* Remove driver and commission from order if failed */
  if (status === 'failed') {

    /* remove driver and commission */
    update.$unset = { 'commission.driver': 1, 'delivery.courier': 1 };

    /**
     * If reason is food not ready
     * update the estimate time and the prepare time
     * and update the delivery.status to processing
     */
    if (body.reason === 'food-not-ready') {

      /* Get the number of delay in minutes */
      const delay = parseInt(body.description.match(/\d+/)[0], 10);

      /* Get order by id */
      const order = await this.accountFind({ id: next.order._id });

      /* Get old prepare time */
      const oldPrepare = _.get(order, 'restaurant.delivery.prepare');

      /* Calucate prepare time of the restaurant: now - createdTime + delay */
      /* So that when we re-run tron, it can dispatch driver later */
      const newPrepare = Moment(time).diff(next.order.createdAt, 'minute') + delay;

      /**
       * Get the diff time of new prepare time and old prepare time
       * and add it to the estimate time
       * */
      const delayDiff = newPrepare - oldPrepare;

      /* update estimate */
      update.$inc = {
        'restaurant.delivery.estimate.min': delayDiff,
        'restaurant.delivery.estimate.max': delayDiff,
        'delivery.estimate.min':            delayDiff,
        'delivery.estimate.max':            delayDiff
      };

      /* Update restaurant prepare time */
      update.$set['restaurant.delivery.prepare'] = newPrepare;

      /* Update delivery.status to processing so that tron can re-run with this order */
      update.$set['delivery.status'] = 'processing';

    }
  }

  /* update order */
  await orderUpdate(
    {
      id:   next.order._id,
      data: update
    }
  );

  /* Create event with the estimate time and actual time comparison */
  const data = {
    courier:     _.pick(account, '_id', 'email', 'phone', 'name', 'image'),
    stop:        next,
    reason:      body.reason,
    description: body.description,
    estimate:    body.status === 'arrived' ? next.arriveAt : next.finishAt,
    actual:      time,
    diff
  };

 
  /* Create event */
  await eventCreate(
    {
      data,
      name:  status === 'completed' ? 'order.delivered' : `order.delivery.${status}`,
      scope: {
        order:      next.order._id,
        account:    id,
        restaurant: _.get(next, 'order.restaurant._id')
      }
    }
  );

  /* Notify customer if driver has arrived at dropoff location */
//   if (status === 'at-dropoff') {

//     /* Get detailed message */
//     const lang = _.get(next, 'order.customer.language') || 'en-US';
//     const trans = this.get('order.options.message');
//     const message = _.get(trans, `arrivedDropoff.${lang}`);

//     /**
//      * Push the notification to the customer
//      */
//     await this.actAsync('ns:order,cmd:push', {
//       id:       next.order._id,
//       message,
//       sms:     true
//     });
//   }


  /* Update estimate time for subsequent stops */
  AdjStops(stops, diff);


  /* Save new stops to driver */
  const updated = await accountUpdate(
    {
      id,
      data: { $set: { stops } }
    }
  );

  /* Update the last stops update time for region */
  // const role = _.find(account.roles, { name: 'region.driver' });

  /*  update tron udpated */
  // run tron manually
  // if (role) {
  //   await redis.set(`stops:${role.scope}`, Date.now());

  //   /* Re-run tron when driver arrived or failed */
  //   if (body.status === 'arrived' || body.status === 'failed') {
  //     await createRoute({ region: role.scope });
  //   }
  // }

  return updated.stops;
}

async function createStop({id}){
  
  /**
   * Find the account in question
   */
  const account = await accountFind({ id });

  /* Account is needed */
  if (!account) {
    throw new Error('no account !');
  }


  /* Get the current destination, and route */
  const stops = _.get(account, 'stops');


  /* If driver has existing en-route order, throw error */
  if (stops.next) {
    throw new Error('Please finish current order before getting new one');
  }


  /* Pop the next stop from route to be the new next */
  stops.next = (stops.route || []).shift();


  /* If no order in the queue, throw error */
  if (!stops.next) {
    throw new Error('No more order to deliver');
  }

  /* Get Order and restaurant */
  const order = await orderFind({ id: _.get(stops, 'next.order._id') }
  );
  // const restaurant = await restaurantFind({ id: order.restaurant._id });

  /* Fail if someone else is already assigned to the order */
  const oldDriver = _.get(order, 'delivery.courier._id');

  if (
    stops.next.type === 'pickup' &&
    oldDriver &&
    oldDriver.toString() !== id.toString()
  ) {

    /* Run tron to refresh the route for this case */
    // await createRoute({ region: order.region._id });

    throw new Error('Someone else took this order, Tron is looking for new orders, please wait.');
  }

  /* Calculate Driver Commission */
  // let commission =  fee({
  //   value: order.fees.delivery,
  //   f:     account.commission
  // });

  // /* Add restaurant bonus if any */
  // if (restaurant.bonus) {
  //   commission += await fee({
  //     value: order.fees.delivery,
  //     f:     restaurant.bonus
  //   });
  // }

  /* Get courier information from account */
  const courier = _.pick(account, '_id', 'email', 'phone', 'name', 'image');

  /**
   * Update the status of the new order
   * Assign driver to the order
   * Calculate driver commission
   */
  await orderUpdate(
    {
      id:   stops.next.order._id,
      data: {
        $set: {
          'delivery.status':   `en-route-to-${stops.next.type}`,
          'delivery.courier':  courier
        }
      }
    }
  );

  
  /* And Create event for the new order */
  await eventCreate( {
    data: {
      courier,
      stop:     stops.next,
      estimate: stops.next.finishAt
    },
    name:  `order.delivery.en-route-to-${stops.next.type}`,
    scope: {
      order:   stops.next.order._id,
      account: id
    }
  });

  /* set alert to be 0, and update startAt */
  stops.alert = 0;
  stops.startAt = stops.next.finishAt;

  /* Save new stops to driver */
  const updated = await accountUpdate({
    id,
    data: { $set: { stops } }
  });

  /* Update the last stops update time for region */
  const role = _.find(account.roles, { name: 'region.driver' });

  /* update tron updated  */
  if (role) {
    await redis.set(`stops:${role.scope}`, Date.now());

    /* this.actAsync('ns:tron,role:route,cmd:create', { region: role.scope }); */
  }

  return updated.stops;
}


module.exports={
    updateTron,
    updateStop,
    createStop
}
