const rp = require('request-promise');

const TRON_HOSTNAME = 'http://tron-proxy-load-356607125.us-east-1.elb.amazonaws.com';

async function tronClient({fleet, visits, options}) {
    const opts = {
      uri:    TRON_HOSTNAME,
      body:   {
        visits,
        fleet,
        options
      },
      json:   true // Automatically stringifies the body to JSON
    };

    /* Call tron server to get route solution */
    const res = await rp.post(opts);
    return res;
}


module.exports = tronClient;