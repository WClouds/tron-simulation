const _ = require('lodash');
const moment = require('moment');

function handleDropoffPenaltyInput(data) {
  /* Get visits and fleet */
  const {
    visits,
    fleet,
    createdAt
  } = data;

  const createUnix = moment(createdAt).unix()
  const now = moment().unix();
  const sub = now - createUnix
  console.log('sub===>', sub);

  /* Adjust for stops */
  _.forEach(visits, ({
    pickup,
    dropoff
  }) => {

    /* Add 7 days to picup start */
    if (pickup.start) {
      pickup.start += sub;
    }

    /* Add 7 days */
    if (pickup.end) {
      pickup.end += sub;
    }

    /* Add 7 days */
    if (dropoff.start) {
      dropoff.start += sub;
    }

    /* Add 7 days */
    if (dropoff.end) {
      dropoff.end += sub;
    }
  });

  /* Adjust for driver start time */
  _.forEach(fleet, fl => {

    /* Add 7 days to shift */
    if (fl.shift_start) {
      fl.shift_start += sub;
    }
  });

  return {
    data,
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

module.exports = {
  handleDropoffPenaltyInput,
  handleDropoffPenaltyOutput
}