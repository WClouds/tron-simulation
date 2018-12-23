const { generate } = require('../utils/uid');
const { eventModel } = require('../connection');

async function eventCreate({data}){

  console.log('event');

  /* Only allow auto-generated timestamps */
  data.createdAt = new Date();
  data._id = generate('evt');

  /* Insert the event */
  return await eventModel.create(data);
}

module.exports={
    eventCreate
}