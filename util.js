const _ = require('lodash');
const moment = require('moment');

function handleDropoffPenaltyInput(data) {
  /* Get visits and fleet */
  let {
    visits,
    fleet,
    time: createdAt
  } = data;

  if (!_.isNumber(createdAt)) {
    createdAt = moment(createdAt).unix()
  }

  // const createUnix = moment(createdAt).unix()
  const now = moment().unix();
  const subTime = now - createdAt

  /* Adjust for stops */
  _.forEach(visits, ({
    pickup,
    dropoff
  }) => {

    /* Add 7 days to picup start */
    if (pickup.start) {
      pickup.start += subTime;
    }

    /* Add 7 days */
    if (pickup.end) {
      pickup.end += subTime;
    }

    /* Add 7 days */
    if (dropoff.start) {
      dropoff.start += subTime;
    }

    /* Add 7 days */
    if (dropoff.end) {
      dropoff.end += subTime;
    }
  });

  /* Adjust for driver start time */
  _.forEach(fleet, fl => {

    /* Add 7 days to shift */
    if (fl.shift_start) {
      fl.shift_start += subTime;
    }
  });

  return {
    input: data,
    subTime
  };
}

function handleDropoffPenaltyOutput(output, subTime) {
  /* Iterate routes */
  _.forEach(output.solution, route => {

    /* Iterate route */
    _.forEach(route, r => {

      /* Substract arrival time */
      if (r.arrival_time) {
        r.arrival_time -= subTime;
      }

      /* Substract finish time */
      if (r.finish_time) {
        r.finish_time -= subTime;
      }
    });
  });

  return output;
}

/**
 * Applies a flat/factor fee to an amount.
 * Rounds the result to the nearest integer.
 */
function fee({ value, f }) {

  /* Do nothing if f is not there */
  if (!f) { return 0; }

  /* save defaults value */
  const { flat, factor } = _.defaults(f, { flat: 0, factor: 0 });

  return Math.round(flat + (factor * value));
}


module.exports = {
  handleDropoffPenaltyInput,
  handleDropoffPenaltyOutput,
  fee
}