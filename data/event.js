const { generate } = require('../utils/uid');
const { eventModel } = require('../connection');

async function eventCreate(args){

  console.log('event');

  /* Only allow auto-generated timestamps */
  args.createdAt = new Date();
  args._id = generate('evt');

  /* Insert the event */
  return await eventModel.create(args);
}

module.exports={
    eventCreate
}