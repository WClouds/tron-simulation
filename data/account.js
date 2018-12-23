const { accountModel } = require('../connection');
const _ = require('lodash');
const { canon } = require('../utils/uid');

async function accountFind(args){

    let query = {};

    if(args.id){
        query._id = await canon(args.id);

        return await accountModel.findOne(query);
    }

    if(args.email){
        query.email = args.email;
    }

    return await accountModel.find(query);
}


async function accountUpdate(args){
  const data = args.data || { };


  console.log(args);

  const id = canon(args.id);

  console.log(id);
  /**
   * Push APN
   */
  if (args.apn) {
    const apns = _.compact([].concat(args.apn));

    /* save apn */
    _.set(data, '$addToSet.apn.$each', apns);
  }


  /**
   * UpdatedAt flag
   */
  _.set(data, '$set.updatedAt', new Date());

  return await accountModel.updateOne({_id:id}, {$set: {'stops.route': [123]}});

}

async function accountList({query = { },target,targets,sort,skip,limit,fields}){

  const proj  = { };

  /* Unless otherwise specified, list only active accounts */
  query = _.assign({ suspended: false }, query);

  /* Integrate targets into the query */
  query = Targets(query, target || targets);

  /* Utilize projection options in args */
  proj.sort = sort;
  proj.skip = skip;
  proj.limit = limit;
  proj.fields = fields || {
    email:        true,
    roles:        true,
    createdAt:    true,
    updatedAt:    true,
    suspended:    true,
    location:     true,
    onCall:       true,
    phone:        true,
    limit:        true,
    stripe:       true,
    commission:   true,
    stops:        true,
    transferedAt: true,
    level:        true,
    lock:         true
  };


  return await accountModel.find(query, proj);
}

module.exports = {
    accountFind,
    accountUpdate,
    accountList
}