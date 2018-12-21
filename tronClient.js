const rp = require('request-promise');

const TRON_HOSTNAME = 'http://localhost:5000'

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