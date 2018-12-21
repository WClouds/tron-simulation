/**
 * private/calculate-week.js
 *
 * @author  Hao Chen <a@ricepo.com>
 * @license 2015-16 (C) Ricepo LLC. All Rights Reserved.
 */

const _ = require('lodash');

const week = 7 * 24 * 3600;

/**
 * Fetch routific result timeout after 120 seconds
 */
const timeout = 120;

/**
 *  Add 7 days for all date in request body
 */
function addWeek(data) {

  /* Get visits and fleet */
  const { visits, fleet } = data;

  /* Adjust for stops */
  _.forEach(visits, ({ pickup, dropoff }) => {

    /* Add 7 days to picup start */
    if (pickup.start)  { pickup.start  += week; }

    /* Add 7 days */
    if (pickup.end)    { pickup.end    += week; }

    /* Add 7 days */
    if (dropoff.start) { dropoff.start += week; }

    /* Add 7 days */
    if (dropoff.end)   { dropoff.end   += week; }
  });

  /* Adjust for driver start time */
  _.forEach(fleet, fl => {

    /* Add 7 days to shift */
    if (fl.shift_start) { fl.shift_start += week; }
  });

  return data;
}

/**
 *  Subtract 7 days for all date in the route
 */
function subtractWeek(data) {

  /* Iterate routes */
  _.forEach(data.solution, route => {

    /* Iterate route */
    _.forEach(route, r => {

      /* Substract arrival time */
      if (r.arrival_time) { r.arrival_time -= week; }

      /* Substract finish time */
      if (r.finish_time)  { r.finish_time  -= week; }
    });
  });

  return data;
}

module.exports.addWeek = addWeek;
module.exports.subtractWeek = subtractWeek;
module.exports.timeout = timeout;
