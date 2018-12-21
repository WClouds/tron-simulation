const { generate } = require('../utils/uid');
const { eventModel } = require('../connection');

async function eventCreate({data}){

  /* Only allow auto-generated timestamps */
  data.createdAt = new Date();
  data._id = generate('evt');

  /* Insert the event */
  return stash.insertOne(data);
}

module.exports={
    eventCreate
}