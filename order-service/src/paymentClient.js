const axios = require('axios');

class PaymentServiceUnavailable extends Error {}

class PaymentDeclined extends Error {
  constructor(payment) {
    super(`Payment declined: ${payment.failureReason || 'unknown reason'}`);
    this.payment = payment;
  }
}

class PaymentConflict extends Error {
  constructor(body) {
    super(body.message || 'Payment is in a state that does not allow this action');
    this.body = body;
  }
}

// Synchronous REST client for the Payment Service.
// Resolved through Kubernetes DNS (http://payment-service:3003) inside the cluster.
// Retries are safe: authorize is idempotent per orderId, and capture/refund are idempotent per payment.
function createPaymentClient({
  baseURL = process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003',
  timeoutMs = parseInt(process.env.PAYMENT_TIMEOUT_MS || '3000', 10),
  retries = 2,
} = {}) {
  const http = axios.create({ baseURL, timeout: timeoutMs });

  async function call(method, url, body) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const { data } = await http.request({ method, url, data: body });
        return data;
      } catch (err) {
        const res = err.response;
        if (res && res.status === 402) throw new PaymentDeclined(res.data.payment || {});
        if (res && res.status === 409) throw new PaymentConflict(res.data);
        if (res && res.status < 500) throw err;
        lastError = err;
        if (attempt < retries) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      }
    }
    throw new PaymentServiceUnavailable(`Payment service unavailable: ${lastError.message}`);
  }

  return {
    // authorizePayment: reserve the amount on the customer's instrument.
    authorize: ({ orderId, customerId, amount, method, cardLast4 }) =>
      call('post', '/api/payments', { orderId, customerId, amount, currency: 'INR', method, cardLast4 }),
    // capturePayment: actually charge the reserved amount (when the restaurant accepts).
    capture: (paymentId) => call('post', `/api/payments/${encodeURIComponent(paymentId)}/capture`),
    // getPaymentByOrder: null when the Payment Service has no payment for the order.
    findByOrder: async (orderId) => {
      const list = await call('get', `/api/payments?orderId=${encodeURIComponent(orderId)}`);
      return list[0] || null;
    },
    // refundPayment: compensation when the order is cancelled (void if not captured yet).
    refund: (paymentId, reason) =>
      call('post', `/api/payments/${encodeURIComponent(paymentId)}/refund`, { reason }),
  };
}

module.exports = { createPaymentClient, PaymentServiceUnavailable, PaymentDeclined, PaymentConflict };
