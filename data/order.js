
const { orderModel } = require('../connection');
const  computeDistribution  = require('../utils/compute-distribution');
const { canon } = require('../utils/uid');
const _ = require('lodash');

async function orderFind(args){

    let query = {};

    let proj = {};

    if(args.id){
        query._id = canon(args.id);

        return await orderModel.findOne(query);
    }

    /* Allow search by restaurant */
    if (args.restaurant) {
        query['restaurant._id'] = canon(args.restaurant);
    }

    /* allow search by customers */
    if (args.customer) {
        query['customer._id'] = canon(args.customer);
    }

    /* allow search by region */
    if (args.region) {
        query['region._id'] = canon(args.region);
    }

    /* allow search by driver */
    if (args.driver) {
        query['delivery.courier._id'] = canon(args.driver);
    }

    /* Utilize projection options */
    proj.sort = args.sort;
    proj.skip = args.skip;
    proj.limit = args.limit;
    proj.fields = args.fields;

    return await orderModel.find(query,proj);
}

async function orderUpdate({id,query,data={}}){

  /* Only support ID or query */
  if (id && query) {
    throw new Error('Update requires either query or ID' );
  }

  /* Require one of them */
  if (!id && !query) {
    throw new Error('Update requires either query or ID' );
  }

  /* UpdatedAt flag */
  _.set(data, '$set.updatedAt', new Date());

  /* if update one, recompute distribution and update to the mongodb again */
  if (id) {

    /* fetch new total and adj */
    let newTotal = _.get(data, '$set.total');
    let newAdj = _.get(data, '$set.adjustments.customer');

    /* if either total or adjustments are updated, it should run the re-charge process */
    // if (_.isFinite(newTotal) || _.isFinite(newAdj)) {


    //   /* first get the order detail */
    //   const order = await stash.findById(id);
    //   const source = order.stripe.source;

    //   /* get the new charge amount */
    //   newTotal = _.isFinite(newTotal) ? newTotal : order.total;
    //   newAdj = _.isFinite(newAdj) ? newAdj : _.get(order, 'adjustments.customer', 0);

    //   const newAmount = newTotal - newAdj;

    //   /* credit card / apple pay charge */
    //   if (_.get(source, 'id')) {

    //     let settled = {};

    //     try {

    //       /* re-charge */
    //       settled = await this.actAsync('ns:stripe,role:charge,cmd:settle', {
    //         id:          order.stripe.id,
    //         amount:      newAmount,
    //         customer:    order.stripe.customer,
    //         source:      source.id,
    //         skipCapture: true /* make sure only recharge, will capture after 12 hour*/
    //       });
    //     } catch (err) {
    //       throw OhShit('order-data-update', { data: err, message: err.raw.message });
    //     }

    //     /* if refund exists, it means recharged */
    //     if (settled.refund) {

    //       /* Get required fileds */
    //       const stripe = _.pick(settled.charge, 'id', 'source', 'customer', 'captured', 'refunded');

    //       /* Update the order with newest charge details */
    //       stripe.original = settled.refund.charge;

    //       /* Push a new event; also update the order */
    //       this.actAsync('ns:event,cmd:create', {
    //         name:   'order.payment.recharged',
    //         data:   stripe,
    //         scope:  { order: order._id },
    //         origin: 'stripe'
    //       });
    //     }


    //   }

    //   /* wechat / alipay */
    //   /* create a new patch for customer to pay */
    //   if (source === 'wechat' || source === 'alipay') {

    //     /* Create recharge order */
    //     const dup = await this::wechatOvercharge(order, newAmount);

    //     /* if created new order, link to original order */
    //     if (dup) {
    //       _.set(data, '$addToSet.recharge', dup._id);
    //     }

    //   }

    // }

    /* First update data */
    const updatedOrder = await orderModel.updateOne({_id:id},data);
    

    /* Compute distribution with updated data */
    const distribution = await computeDistribution({ order: updatedOrder });

    /* Update new distribution */
    return await orderModel.updateOne({_id:id}, { $set: { distribution } });
  }

  /* update many does not update distribution (only used in pexcard update) */
  return { n: await orderModel.updateMany(query, data) };
}

async function orderList(args){

    const query = args.query || { };
    const proj  = { };
  
    /* Allow restricting orders by restaurant/region */
    if (args.restaurant) {
      query['restaurant._id'] = canon(args.restaurant);
    }
  
    /* Allow restricting orders by customer */
    if (args.customer) {
      query['customer._id'] = canon(args.customer);
    }
  
    /* Allow restricting orders by region */
    if (args.region) {
      query['region._id'] = canon(args.region);
    }
  
    /* Allow restricting orders by driver */
    if (args.driver) {
      query['delivery.courier._id'] = canon(args.driver);
    }
  
    /* Utilize projection options */
    proj.sort = args.sort;
    proj.skip = args.skip;
    proj.limit = args.limit || 1000;
    proj.fields = args.fields || { commission: false };
  
    return await orderModel.find(query, proj);
}

module.exports={
    orderFind,
    orderUpdate,
    orderList
}