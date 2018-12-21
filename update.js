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

async function updateStop({id,body}){
    
  /**
   * Find the account in question
   */
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
    next.arrivedAt = new Date();
    diff = Moment().diff(next.arriveAt, 'minute');
    status = `at-${next.type}`;
  }

  /* Complete the stop */
  if (body.status === 'completed') {

    /* Prevent double complete at the same stop */
    if (!next.arrivedAt) {
      throw new Error('Cannot complete the stop before arriving');
    }

    /* Update the stop finishedAt time & Calculate diff with estimate time */
    next.finishedAt = new Date();
    diff = Moment().diff(next.finishAt, 'minute');
    status = next.type === 'pickup' ? 'pickup-completed' : 'completed';

    /* remove the next from stop */
    stops.next = null;
  }

  /* Failed the stop */
  if (body.status === 'failed') {

    /* Update the stop finishedAt time & Calculate diff with estimate time */
    diff = Moment().diff(next.finishAt, 'minute');
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
      const newPrepare = Moment().diff(next.order.createdAt, 'minute') + delay;

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
    actual:      new Date(),
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
  const role = _.find(account.roles, { name: 'region.driver' });

  /*  update tron udpated */
  if (role) {
    await redis.set(`stops:${role.scope}`, Date.now());

    /* Re-run tron when driver arrived or failed */
    if (body.status === 'arrived' || body.status === 'failed') {
      await createRoute({ region: role.scope });
    }
  }

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
  const restaurant = await restaurantFind({ id: order.restaurant._id });

  /* Fail if someone else is already assigned to the order */
  const oldDriver = _.get(order, 'delivery.courier._id');

  if (
    stops.next.type === 'pickup' &&
    oldDriver &&
    oldDriver.toString() !== id.toString()
  ) {

    /* Run tron to refresh the route for this case */
    await createRoute({ region: order.region._id });

    throw new Error('Someone else took this order, Tron is looking for new orders, please wait.');
  }

  /* Calculate Driver Commission */
  let commission =  fee({
    value: order.fees.delivery,
    f:     account.commission
  });

  /* Add restaurant bonus if any */
  if (restaurant.bonus) {
    commission += await fee({
      value: order.fees.delivery,
      f:     restaurant.bonus
    });
  }

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
          'delivery.courier':  courier,
          'commission.driver': commission
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
    await this.redis.set(`stops:${role.scope}`, Date.now());

    /* this.actAsync('ns:tron,role:route,cmd:create', { region: role.scope }); */
  }

  return updated.stops;
}


module.exports={
    updateTron,
    updateStop,
    createStop
}






async function optimize(region){


  let query;
  let fields;

  /**
   *
   * Drivers -> Fleet
   *
   **/

  /* Build query */
  query = {

    /* Has driver role with that region */
    roles: {
      $elemMatch: {
        name:  'region.driver',
        scope: region._id.toString()
      }
    },

    /* Either online or still has some order to deliver */
    $or: [
      { onCall: true },
      { 'stops.next': { $ne: null } }
    ],
    location: { $ne: null },

    /* Not suspended */
    suspended: false
  };

  /* Build Fields */
  fields = {
    email:    1,
    location: 1,
    stops:    1,
    onCall:   1
  };

  /* Fetch Drivers */
  const drivers = await accountList({ query, fields });

  /* construct shift query */
  const shiftQuery = {
    start:        { $lte: Moment().toDate() },
    end:          { $gte: Moment().toDate() },
    'region._id': region._id,
    available:    { $gte: 1 }
  };

  /* Get shift list at this moment with region id */
  const shifts = await shiftList({ query: shiftQuery });

  /**
   * XXX temporary
   * find driver currently working on NCD pickup
   * and let him to take all NCD
   * has to be only one matching driver
   */
  const ncd = _.filter(drivers, d =>

    d.onCall &&
    _.get(d, 'stops.next.type') === 'pickup' &&
    _.get(d, 'stops.next.order.restaurant._id', '').toString() === '55d8a858922db50c373692eb');
  const ncdDriver = _.size(ncd) === 1 ? ncd[0] : null;

  /* Convert to fleet */
  const fleet = _.reduce(drivers, (f, d) => {

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
        lat:  _.get(d, 'location.coordinates[1]'),
        lng:  _.get(d, 'location.coordinates[0]')
      },
      shift_start: Moment(d.start).unix()

      /* TODO: Add shift_end later */
    };

    /**
     * Find shift with driver id
     * if exist, means driver is on scheduled
     */
    const shift = _.find(
      shifts,
      (s) => _.find(s.drivers, driver => driver._id.toString() === d._id.toString())
    );

    /**
     * If driver is not on scheduled, give lower speed
     * otherwise, give higher speed
     * it makes on scheduled drivers get higher priority to get orders
     */
    fl.speed = _.isEmpty(shift) ? 0.6 : 1;

    /* Assign */
    _.set(f, d._id, fl);

    return f;
  }, {});


  /* Throw Error if no driver */
  if (_.isEmpty(fleet)) {
    throw new Error('No couriers available at this time');
  }



  /**
   *
   * Orders -> Visits
   *
   **/
  /* Build query */
  query = {

    /* Order must not be fake */
    'restaurant.fake': false,

    /* Must be RICEPO delivery */
    'delivery.provider': 'ricepo',

    /* Delivery must exists */
    'delivery._id': { $ne: null },

    /* Must not be delivered or failed */
    'delivery.status': { $nin: [ 'completed', 'failed' ] },

    /* Must not be delivered */
    'delivery.time': null,

    /* Must be confirmed */
    status: 'confirmed',

    /* Order must be created within the last 24 hours */
    createdAt: {
      $gte: Moment()
        .subtract(24, 'hours')
        .toDate()
    }
  };

  /* Build Fields */
  fields = {
    passcode:   1,
    restaurant: 1,
    createdAt:  1,
    delivery:   1,
    tron:       1
  };

  /* Fetch Orders */
  const orders = await orderList( {
    query,
    fields,
    region: region._id,
    sort:   { createdAt: 1 }
  });


  /**
   * XXX temporary
   * 如果有符合的司机
   * 那就找到这个司机手上最早的新成都 可以是pickup completed
   * 然后看35分钟内有多少新成都
   * 如果35分钟内加上现在拿的小于等于5 那就把这些订单全部强制给这个司机
   */
  if (ncdDriver) {

    console.log('NCD Driver', ncdDriver._id);

    /* find the time of the first order for that driver */
    const earliest = _
      .chain(orders)
      .find(o =>

        _.get(o, 'delivery.courier._id', '').toString() === ncdDriver._id.toString() &&
        _.get(o, 'restaurant._id', '').toString() === '55d8a858922db50c373692eb')
      .get('createdAt')
      .value();

    console.log('NCD eariliest', earliest);

    const ncdOrders = _.filter(orders, o =>

      (
        !_.get(o, 'delivery.courier._id') ||
        _.get(o, 'delivery.courier._id', '').toString() === ncdDriver._id.toString()
      ) && // No driver assigned
      Moment(o.createdAt).diff(earliest, 'minute') < 35 && // Within 35 min apart
      _.get(o, 'restaurant._id', '').toString() === '55d8a858922db50c373692eb');

    console.log('NCD match', ncdOrders.length);

    /* assign other NCD to the driver, if total order < 6 */
    if (ncdOrders.length < 6) {
      _.forEach(ncdOrders, o => {

        console.log('NCD Set', o._id);
        _.set(o, 'delivery.courier', ncdDriver);
      });
    }
  }

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

  const tronObj = _.get(region, 'tron');

  /* Get the provider of tron: routific/tron */
  const provider = _.get(tronObj, 'provider');

  /* If provider is not tron or multi level penalty for dropoff is not open
   * adjust dropoff end
  */
  if (provider !== 'tron' || !_.get(tronObj, 'options.open_dropoff_multi_level_penalty')) {

    /* If current time later than dropoff.end, it makes no sense */
    /* Adjust dropoff end, remove already past time */
    /* First find the diff between now and eariliest dropoff end */
    const oldest = _
      .chain(visits)
      .map()
      .minBy('dropoff.end')
      .value();

    /* Use Date.now to mock datetime conveniently */
    const now = Math.floor(Date.now() / 1000);
    let diff = now - oldest.dropoff.end;

    /* If still not starting pickup, give more time */
    if (_.get(oldest, 'pickup.location.name') !== 'ignore') {
      diff += 900;
    }

    Debug(`DIFF: ${diff}`);

    /* Second remove this diff, to make the eariliest order even with now */
    /* Only when diff is positive */
    if (diff > 0) {
      _.forEach(visits, v => {

        /* Find difference with latest order */
        const delta = v.dropoff.end - oldest.dropoff.end;

        /* Adjust for non-late order */
        let adjust = Math.round(delta / 4);

        if (adjust > diff) { adjust = diff; }

        v.dropoff.end += diff - adjust;
      });
    }

  }

  /**
   * Call tron or routific server to get route solution
   */
  if (provider === 'tron') {

    /* Get tron client */


    /* Get tron options */
    const options = _.get(tronObj, 'options');

    /* Construct tron options */
    const tronOptions = {
      lateness_penalty:                 _.get(options, 'lateness_penalty') || 15,
      duration_coefficient:             _.get(options, 'duration_coefficient') || 1,
      map:                              _.get(options, 'map'), // Map data tag
      open_pickup_late_penalty:         _.get(options, 'open_pickup_late_penalty') || false,
      open_dropoff_multi_level_penalty: _.get(options, 'open_dropoff_multi_level_penalty') || false,
      dropoff_multi_level_penalty:      {

        /* default is 15minutes as a level */
        split_minute:        _.get(options, 'dropoff_multi_level_penalty.split_minute') || 15,

        /* penalty coefficient, default is 1 */
        penalty_coefficient: _.get(options, 'dropoff_multi_level_penalty.penalty_coefficient') || 1
      }
    };

    const res = await tronClient({ visits, fleet, options: tronOptions });

    /* And Create event for the tron output */
    // this.actAsync('ns:event,cmd:create', {
    //   data:  { tron: res, input: { visits, fleet, options: tronOptions } },
    //   name:  'tron.output',
    //   scope: { region: region._id }
    // });

    /* Error, throw it */
    if (res.status === 'error') {
      throw new Error(res.output);
    }

    /* Finished, return result */
    if (res.status === 'finished') {

      /* If unserved orders exist, get the passcode */
      if (_.get(res, 'output.unserved') && _.isObject(_.get(res, 'output.unserved'))) {
        res.output.unservedPasscode = _.chain(_.get(res, 'output.unserved'))
          .keys()
          .map(orderId => _.find(orders, { _id: orderId }).passcode)
          .value();
      }

      return res.output;
    }

  } else {

    /* OPtions */
    const options = {
      polylines:          true,
      max_visit_lateness: 300,
      squash_durations:   1,
      shortest_distance:  !!process.env.SHORTEST_DISTANCE,
      traffic:            'slow' // Use Google maps traffic API
    };

    /* Prepare data */
    const data = addWeek({ visits, fleet, options });

    /* Print out Prepare data */
    Debug(JSON.stringify(data, null, 2));

    /* if (1 + 1 === 2) { throw new Error('No more deliveries to plan'); } */
    const client = this.get('tron.routific.client');

    /* Log cureent time and call Routific using pdp-long */
    const start = Moment();
    const { job_id } = await client.pdpLong(data);

    /* Fetch result every 2 seconds until timeout after 45 seconds */
    while (Moment().diff(start, 'seconds') < timeout) {

      /* First pause for 2 seconds */
      await new Promise(resolve => setTimeout(resolve, 2000));

      /* Then Fetch job result */
      const res = await client.jobs(job_id);

      /* Finished, return result */
      if (res.status === 'finished') {

        /* And Create event for the routific output */
        // this.actAsync('ns:event,cmd:create', {
        //   data:  { routific: res, input: { visits, fleet, options } },
        //   name:  'tron.output',
        //   scope: { region: region._id }
        // });

        /* If unserved orders exist, get the passcode */
        if (_.get(res, 'output.unserved') && _.isObject(_.get(res, 'output.unserved'))) {
          res.output.unservedPasscode = _.chain(_.get(res, 'output.unserved'))
            .keys()
            .map(orderId => _.find(orders, { _id: orderId }).passcode)
            .value();
        }

        return subtractWeek(res.output);
      }

      /* Error, throw it */
      if (res.status === 'error') {
        throw new Error(res.output);
      }

    }

    /* If reach here, it means 60 sec passed, we throw time-out error */
    throw new Error('TRON timeout');
  }

  return null;
}


async function createRoute({region}){
    /* Convert region from id to the region object */
  region = await regionFind( { id: region });

  try {
    const tronObj = _.get(region, 'tron');

    /* Only run for selected regions */
    if (!tronObj) { return; }

    /* Only run tron if provider is routific or our own tron  */
    const provider = _.get(tronObj, 'provider');
    const tronMap = _.get(tronObj, 'options.map');

    if (provider !== 'routific' && provider !== 'tron') { return; }

    /* Throw error if provider is tron  but map data not provided */
    if (provider === 'tron' && !tronMap) {
      throw new Error('Map data of tron is not provided');
    }

    /* Set the timestamp for current time */
    const current = Date.now();

    /* Mark the LATEST TRON start time */
    await redis.set(`tron:${region._id}`, current);

    /* RUN TRON */
    const route = await optimize(region);

    /* Check if any NEW TRON started while running this tron */
    const latest = await redis.get(`tron:${region._id}`);

    /* Panic if TRON is duplicate */
    if (current < latest) {
      throw new Error('Duplicate TRON tasks');
    }

    /* Get Updated TRON */
    const updated = await redis.get(`stops:${region._id}`);

    /* Check if any STOPS UPDATED by driver while running this tron */
    if (updated && current < updated) {

      /* Need to rerun tron for this case */
      await createRoute({ region: region._id });

      throw new Error('Driver status changed while tron was running');
    }


    /* Check if all orders are served */
    if (!route || _.get(route, 'unserved')) {
      if (_.get(route, 'unserved') && _.isObject(_.get(route, 'unserved'))) {
        throw new Error(`Unable to serve all orders: ${JSON.stringify(_.get(route, 'unservedPasscode'))}`);
      }

      Debug(_.get(route, 'unserved'));

      throw new Error('Unable to serve all orders');
    }

    /* Update route to drivers */
    await updateTron(route);

  } catch (err) {

    /* No need to alert for 'duplicate tron' or 'no more deliveries' */
    if (/deliveries to plan|status changed|duplicate tron/i.test(err)) {
      return;
    }

    throw err;
  }
}