const { randomUUID } = require('crypto');

// Simulated payment gateway (stands in for Razorpay / Stripe / a bank).
// Deterministic rules so the demo and the tests can show both outcomes:
//   * amount above PAYMENT_LIMIT (default 10000 INR)  -> declined "AMOUNT_LIMIT_EXCEEDED"
//   * CARD ending in 0000                              -> declined "CARD_DECLINED_BY_ISSUER"
//   * WALLET with amount above WALLET_BALANCE (2000)    -> declined "INSUFFICIENT_WALLET_BALANCE"
// Everything else is approved with a gateway reference.
function createGateway({
  limit = Number(process.env.PAYMENT_LIMIT || 10000),
  walletBalance = Number(process.env.WALLET_BALANCE || 2000),
} = {}) {
  function authorize({ amount, method, cardLast4 }) {
    if (amount > limit) return { approved: false, reason: 'AMOUNT_LIMIT_EXCEEDED' };
    if (method === 'CARD' && cardLast4 === '0000') return { approved: false, reason: 'CARD_DECLINED_BY_ISSUER' };
    if (method === 'WALLET' && amount > walletBalance) return { approved: false, reason: 'INSUFFICIENT_WALLET_BALANCE' };
    return { approved: true, reference: `gw-${randomUUID().slice(0, 12)}` };
  }
  return { authorize };
}

module.exports = { createGateway };
