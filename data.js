const mongoose = require('mongoose');
const _ = require('lodash')

const Schema = mongoose.Schema;

const url = process.env.MONGO_URI;

const options = {
  dbName: 'live',
  useNewUrlParser: true
}

mongoose.connect(url, options);

const start = new Date('2018-12-16T23:00:00+08:00');
const end = new Date('2018-12-17T23:00:00+08:00');

// chicago
// const regionId = mongoose.Types.ObjectId('5643797e0d288d07f1e0033a');

// bloomington
// const regionId = mongoose.Types.ObjectId('55982fe88f6dfb1987d5dda5');

// allston
const regionId = mongoose.Types.ObjectId('56280f780d288d07f1dfffe1');

// tempe
// const regionId = mongoose.Types.ObjectId('5664f1e20d288d07f1e005dc');

// lansing
// const regionId = mongoose.Types.ObjectId('57195cfb9ad9fe1100ebbd7b');

// gainsvile
// const regionId = 'reg_ByRQvy7Mm';

async function getOrders() {
  try {

    /* Define order model */
    const orderModel = mongoose.model('orders', new Schema({
      _id: String
    }))

    /* Construct query */
    const query = {
      createdAt: {
        $gt: start,
        $lt: end
      },
      status: 'confirmed',
      'delivery.time': {
        $ne: null
      },
      'region._id': regionId,
      'delivery.provider': 'ricepo'
    }
    const projection = {}
    const options = {
      sort: {
        createdAt: 1
      }
    }

    return await orderModel.find(query, projection, options).lean()
  } catch (err) {
    console.log('err==>', err);
    return null
  }
}

async function getJobs() {
  try {
  /* Define job model */
  const jobModel = mongoose.model('jobs', new Schema({
    _id: String,
    start: Date,
    driver: Object,
    region: Object,
    createdAt: Date,
    updatedAt: Date,
    duration: Number,
    end: Date
  }))
  const query = {
    'region._id': regionId,
    start: {
      $gte: start
    },
    end: {
      $lte: end
    }
  }
  return await jobModel.find(query)
  } catch (err) {
    console.log('err===>', err);
    return null;
  }
}

async function getAccounts(ids) {
  try {
    /* Define account model */
    const accountModel = mongoose.model('accounts', new Schema({
      _id: Schema.Types.Mixed,
      shifts: Object,
      stops: Object
    }));
    return await accountModel.find({ _id: {$in: ids} }).lean()
  } catch (err) {
    console.log('err===>', err);
    return null;
  }
}

async function getRegion() {
  try {
    /* Define region model */
    const regionModel = mongoose.model('regions', new Schema({
      _id: Schema.Types.Mixed,
      tron: Object,
    }));
    return await regionModel.findById(regionId).lean()
  } catch (err) {
    console.log('err===>', err);
    return null;
  }
}

async function init() {

  /* Get orders */
  const orders = await getOrders();

  /* Get jobs */
  const jobs = await getJobs();

  /* Group jobs by driver id */
  const groupIdJobs = _.groupBy(jobs, (job) => (job.driver._id))

  /* Get driver id list */
  const driverIds = _.chain(jobs)
    .map(job => job.driver._id)
    .uniqBy((i) => (i.toString()))
    .value();

  /* Get accounts by id */
  let accounts = await getAccounts(driverIds);

  /* Add shifts in accounts */
  accounts = _.map(accounts, account => {
    const accountId = account._id;
    const shifts = groupIdJobs[accountId.toString()]
    account.shifts = shifts

    /* Clear stops */
    account.stops.polyline = null;
    account.stops.route = [];
    account.stops.next = null;

    return account;
  })

  const region = await getRegion();

  return {
    accounts,
    orders,
    region
  }
}

module.exports = {
  init
}
