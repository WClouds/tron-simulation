const { restaurantModel } = require('./connection');
const { canon } = require('../utils/uid');

async function restaurantFind(args){

  const query = args.query || { };
  const proj  = args.proj  || { };

  /*!
   * If there is a fields projection, MongoStash cannot
   * apply it while simultaneously utilizing cache.
   * TODO Simplify this after MongoStash gets support for fields projection.
   */
  if (args.id) {

    if (!args.fields) {
      return await restaurantModel.find({_id:args.id});
    }

    query._id = canon(args.id);
    proj.fields = args.fields;
  }

  return await restaurantModel.findOne(query, proj);
}

module.exports = {
    restaurantFind
}