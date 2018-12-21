const Redis = require('ioredis');
const redis = new Redis();

redis.on('ready',()=>{

    console.log('redis connection success');
});

module.exports = redis;