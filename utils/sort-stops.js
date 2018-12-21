const _            = require('lodash');
const Moment       = require('moment');

/**
 * Sort stops
 */
function sort(stops) {

  /* Get first stop */
  const first = _.head(stops);

  /* If no stop or first stop is dropoff, do nothing */
  if (!first || first.type === 'dropoff') {
    return stops;
  }

  /* save first stops arriveAt and restaurant id */
  let previousArrive = first.arriveAt;
  const restId = first.order.restaurant._id;

  /* Get collection of all stops from same restaurant pickup and sort them as per order.createdAt */
  let commonStops = [];

  /* Iterate stops */
  _.forEach(stops, v => {

    /* Add stop */
    if (v.type === 'pickup' && v.order.restaurant._id.toString() === restId.toString()) {
      commonStops.push(v);

      return true;
    }

    return false;
  });
  commonStops = _.sortBy(commonStops, v => v.order.createdAt);

  /* Compute the arriveAt and finishAt time for each stop */
  for (const s of commonStops) {
    s.finishAt = _.max([
      addMin(previousArrive, 2),
      addMin(s.order.createdAt, _.get(s, 'order.restaurant.delivery.prepare') || 15)
    ]);
    s.arriveAt = addMin(s.finishAt, -2);
    previousArrive = s.finishAt;
  }

  /* Save the new order stops in final stops */
  for (let i = 0; i < commonStops.length; i++) {
    stops[i] = commonStops[i];
  }

  return stops;
}

/**
 *  Utility function for adding min to a date
 */
function addMin(date, min) {

  /* Add minute */
  return Moment(date).add(min, 'minute').toDate();
}

module.exports.sort = sort;
