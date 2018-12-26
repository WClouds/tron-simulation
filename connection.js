const mongoose = require('mongoose');

const Schema = mongoose.Schema;

const options = {
    dbName: 'test',
    useNewUrlParser: true
  }
  const url = 'mongodb://localhost:27017';
  
  const localMongoConn = mongoose.createConnection(url, options);

  localMongoConn.on('connected',()=>{

    console.log('local mongodb connection success');
  });
  
  const accountModel = localMongoConn.model('accounts', new Schema({
    _id: Schema.Types.Mixed,
    email: String,
    type: String,
    phone: String,
    roles: Array,
    commission: Object,
    limit: Object,
    location: Object,
    onCall: Boolean,
    stops: Object,
    shifts: Array
  }));
  
  const orderModel = localMongoConn.model('orders', new Schema({
    _id: String,
    comments: String,
    passcode: String,
    region: Object,
    customer: Object,
    restaurant: Object,
    delivery: Object,
    items: Object,
    destination: Object,
    status: String,
    createdAt: Date,
    updatedAt: Date,
    driver: Object
  }));


  const regionModel = localMongoConn.model('regions',new Schema({

  }));

  const shiftModel = localMongoConn.model('shifts',new Schema({

  }));

  const restaurantModel = localMongoConn.model('restaurants',new Schema({

  }));

  const eventModel = localMongoConn.model('events',new Schema({
    _id:Schema.Types.Mixed,
    req: Object,
    ip: String,
    region: Object,
    name: String,
    data: Object,
    scope:Object,
    origin:String,
    user:Object,
    createdAt: Date,
    expiresAt: Date,
  }));


  module.exports={
    accountModel,
    orderModel,
    regionModel,
    shiftModel,
    restaurantModel,
    eventModel
  }