const _            = require('lodash');


/**
 * Custom sum function that ignores undefined values
 */
function sum(...args) {

  return args
    .filter(i => typeof i === 'number')
    .reduce((m, v) => m + v, 0);
}

/**
 * Compute Distribution
 */
function computeDistribution({ order }) {

  /* Get provider from order */
  const provider = _.get(order, 'delivery.provider') || _.get(order, 'restaurant.delivery.provider') || null;
  const totalAmount = _.get(order, 'total', 0);

  /**
   * If there are no adjustments, populate with zeros
   */
  if (!order.adjustments) {
    order.adjustments = {
      ricepo:     0,
      driver:     0,
      customer:   0,
      restaurant: 0
    };
  }


  /**
   * Compute the ricepo share
   */
  const ricepo = {
    tip:      0,
    total:    0,
    delivery: 0,
    delta:    0
  };

  /* compute delivery fee and tipAmount if provider is there   */
  if (provider) {
    ricepo.delivery = sum(_.get(order, 'fees.delivery'));
    ricepo.tip = sum(_.get(order, 'fees.tip.amount'));
    ricepo.delta = sum(_.get(order, 'fees.delta'));
    ricepo.total = sum(
      _.get(order, 'fees.delivery'),
      _.get(order, 'fees.tip.amount'),
      _.get(order, 'fees.delta')
    );
  }

  /* Get ricepo total */
  ricepo.total += sum(
    _.get(order, 'commission.subtotal'),
    _.get(order, 'commission.total'),
    _.get(order, 'commission.service'),
    _.get(order, 'adjustments.ricepo')
  );

  /**
   * Compute the restaurant share
   */

  /* initialise restaurant as 0 */
  let restaurant = 0;

  if (provider) {
    restaurant = sum(
      _.get(order, 'subtotal'),
      _.get(order, 'fees.tax'),
      _.get(order, 'fees.service'),
      _.get(order, 'fees.credit')
    );
  } else if (order.stripe) {
    restaurant = totalAmount;
  }

  restaurant += sum(_.get(order, 'adjustments.restaurant'));

  /* Get restaurant share */
  restaurant -= sum(

    /**
     * Here we use `order.subtotal` instead of `order.cost`
     * because we will later subtract `order.commission.service`
     * from this value;
     */
    _.get(order, 'commission.subtotal'),
    _.get(order, 'commission.total'),
    _.get(order, 'commission.service')
  );


  /**
   * Compute the driver share
   */
  /* initialise driver as 0 */
  let driver = 0;


  if (provider === 'ricepo') {
    driver += sum(
      _.get(order, 'commission.driver'),
      _.get(order, 'fees.tip.amount')
    );
    driver += sum(_.get(order, 'adjustments.driver'));
  }

  /* initialise thirdparty as 0*/
  let thirdparty = 0;

  /**
   * Compute the thirdparty share
   */
  if (provider && provider !== 'ricepo') {
    thirdparty = _.get(order, 'delivery.fee') || 0;
  }

  /**
   * Compute the stripe share
   */
  const wechatFlag = _.get(order, 'stripe.source') === 'wechat';
  const alipayFlag = _.get(order, 'stripe.source') === 'alipay';

  const payment = {
    wechat: wechatFlag ?  Math.round(totalAmount * 0.012) : 0,
    alipay: alipayFlag ?  Math.round(totalAmount * 0.015) : 0,
    stripe: _.get(order, 'stripe.id') && totalAmount !== 0 ? Math.round(totalAmount * 0.019) + 25 : 0
  };

  const stripe = sum(payment.stripe, payment.wechat, payment.alipay);

  return {
    ricepo,
    driver,
    stripe,
    payment,
    thirdparty,
    restaurant
  };
}

module.exports = computeDistribution;
