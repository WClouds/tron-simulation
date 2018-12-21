const _            = require('lodash');
const Moment       = require('moment');


/**
 * Adjust stops
 */
function adjust(stops, delay = 0) {

  /* get next route and startAt */
  const { next, route, startAt } = stops;

  /* TODO use next.arrivedAt - next.arriveAt to get the diff */

  /* If driver just arrived at the stop, we need to update the finish time */
  if (next) {
    delay = adj(next, delay);
  }

  /*
   * Update the new startAt time to be either
   * 1. current stop's estimate finish time
   * 2. current stop's actual finished time
   * 3. or right now
   */
  stops.startAt = Moment(_.get(next, 'finishedAt') || _.get(next, 'finishAt')).toDate();

  /*
   * If the original assumed start time is set,
   * Use that as the reference and get the new delay time
   */
  if (startAt) {
    delay = Moment(stops.startAt).diff(startAt, 'minute');
  }

  /*
   * Update the estimate time for subsequent stops
   * and generate a new delay time to be used by rest stops
   */
  let stop;

  /* Adjust each stop */
  for (stop of route) {
    delay = adj(stop, delay);
  }

  return stops;

}


/**
 * Adjust for one single stop
 */
function adj(stop, delay) {

  /* Skip if already finished */
  if (stop.finishedAt) {
    return delay;
  }

  /* Directly add delay to arrival time if not arrived yet */
  /* For both pickup and dropoff */
  if (!stop.arrivedAt) {
    stop.arriveAt = addMin(stop.arriveAt, delay);
  }

  /* Directly add delay to finish time for dropoff stop */
  /* Add keep using the same delay for next stop */
  if (stop.type === 'dropoff') {
    stop.finishAt = addMin(stop.finishAt, delay);

    return delay;
  }

  /*
   * Update the finish time for pickup order
   */
  /* Get the food ready time */
  const prepare = _.get(stop, 'order.restaurant.delivery.prepare') || 15;
  const ready = addMin(stop.order.createdAt, prepare);

  /* First assume driver can take food immediately after arrival */
  let finishAt = addMin(stop.arrivedAt || stop.arriveAt, 2);

  /* If the food is not ready at that time,
   * driver need to wait and the possible finish time is the food ready time
   */
  if (ready > finishAt) {
    finishAt = ready;
  }

  /* Compare and get the new delay which will be used by rest stops */
  delay = Moment(finishAt).diff(stop.finishAt, 'minute');

  /* Finally update the finish at */
  stop.finishAt = finishAt;

  return delay;
}


/**
 * Utility function for adding min to a date
 */
function addMin(date, min) {

  return Moment(date).add(min, 'minute').toDate();
}

module.exports = adjust;
