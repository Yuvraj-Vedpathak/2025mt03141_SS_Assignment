const request = require('supertest');
const { newDb } = require('pg-mem');
const { createApp } = require('../src/app');
const { initSchema } = require('../src/db');
const { PaymentServiceUnavailable, PaymentDeclined, PaymentConflict } = require('../src/paymentClient');

// In-memory stub of the Payment Service so the Order Service can be tested independently.
function createStubPayments() {
  const payments = new Map();
  let seq = 0;
  return {
    mode: 'ok',
    payments,
    calls: [],
    async authorize(req) {
      this.calls.push(['authorize', req.orderId]);
      if (this.mode === 'down') throw new PaymentServiceUnavailable('Payment service unavailable');
      const existing = [...payments.values()].find((p) => p.orderId === req.orderId);
      if (existing) return existing;
      const p = { id: `pay-${++seq}`, orderId: req.orderId, amount: req.amount, status: 'AUTHORIZED' };
      if (req.method === 'CARD' && req.cardLast4 === '0000') {
        p.status = 'DECLINED';
        p.failureReason = 'CARD_DECLINED_BY_ISSUER';
        payments.set(p.id, p);
        throw new PaymentDeclined(p);
      }
      payments.set(p.id, p);
      return p;
    },
    async capture(id) {
      this.calls.push(['capture', id]);
      if (this.mode === 'down') throw new PaymentServiceUnavailable('Payment service unavailable');
      const p = payments.get(id);
      if (p.status !== 'AUTHORIZED' && p.status !== 'CAPTURED') throw new PaymentConflict({ message: 'bad state' });
      p.status = 'CAPTURED';
      return p;
    },
    async refund(id) {
      this.calls.push(['refund', id]);
      if (this.mode === 'down') throw new PaymentServiceUnavailable('Payment service unavailable');
      const p = payments.get(id);
      p.status = p.status === 'CAPTURED' ? 'REFUNDED' : 'VOIDED';
      return p;
    },
    async findByOrder(orderId) {
      if (this.mode === 'down') throw new PaymentServiceUnavailable('Payment service unavailable');
      return [...payments.values()].find((p) => p.orderId === orderId) || null;
    },
  };
}

const ORDER = {
  customerId: 'cust-2025MT03141',
  restaurantId: 'rest-001',
  deliveryAddress: 'BITS Pilani WILP, Pune',
  paymentMethod: 'UPI',
  items: [
    { menuItemId: 'item-101', quantity: 2 },
    { menuItemId: 'item-102', quantity: 4 },
  ],
};

let app;
let pool;
let payments;

beforeEach(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await initSchema(pool);
  payments = createStubPayments();
  app = createApp(pool, payments);
});

afterEach(() => pool.end());

const place = (body = ORDER) => request(app).post('/api/orders').send(body);
const setStatus = (id, status) => request(app).patch(`/api/orders/${id}/status`).send({ status });

describe('Order Service', () => {
  test('GET /health reports UP', async () => {
    const res = await request(app).get('/health');
    expect(res.body).toMatchObject({ service: 'order-service', status: 'UP' });
  });

  test('places an order: prices on the server, payment authorized by Payment Service', async () => {
    const res = await place({ ...ORDER, items: ORDER.items.map((i) => ({ ...i, price: 1 })) });
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('PLACED');
    expect(res.body.totalAmount).toBe(2 * 249 + 4 * 45);
    expect(res.body.payment).toMatchObject({ method: 'UPI', status: 'AUTHORIZED' });
    expect(res.body.payment.paymentId).toMatch(/^pay-/);
    expect(res.body.statusHistory.map((h) => h.status)).toEqual(['PAYMENT_PENDING', 'PLACED']);
  });

  test('rejects missing fields and bad payment method', async () => {
    expect((await place({ customerId: 'c' })).status).toBe(400);
    expect((await place({ ...ORDER, paymentMethod: 'CASH' })).status).toBe(400);
    expect((await place({ ...ORDER, paymentMethod: 'CARD' })).status).toBe(400);
    expect(payments.calls).toHaveLength(0);
  });

  test('returns 404 for unknown restaurant and 422 for bad items, without calling Payment', async () => {
    expect((await place({ ...ORDER, restaurantId: 'rest-xyz' })).status).toBe(404);
    const res = await place({ ...ORDER, items: [{ menuItemId: 'item-201', quantity: 1 }, { menuItemId: 'item-104', quantity: 1 }] });
    expect(res.status).toBe(422);
    expect(res.body.details).toHaveLength(2);
    expect((await place({ ...ORDER, items: [{ menuItemId: 'item-101', quantity: 0 }] })).status).toBe(422);
    expect(payments.calls).toHaveLength(0);
  });

  test('declined payment returns 402 and leaves the order PAYMENT_FAILED', async () => {
    const res = await place({ ...ORDER, paymentMethod: 'CARD', cardLast4: '0000' });
    expect(res.status).toBe(402);
    expect(res.body.error).toBe('PAYMENT_DECLINED');
    expect(res.body.order.status).toBe('PAYMENT_FAILED');
    expect(res.body.order.payment.status).toBe('DECLINED');
    expect((await setStatus(res.body.order.id, 'ACCEPTED')).status).toBe(409);
  });

  test('Payment Service down: 503, order kept PAYMENT_PENDING, retry succeeds', async () => {
    payments.mode = 'down';
    const res = await place();
    expect(res.status).toBe(503);
    expect(res.body.order.status).toBe('PAYMENT_PENDING');

    payments.mode = 'ok';
    const retry = await request(app).post(`/api/orders/${res.body.order.id}/payment`);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('PLACED');
    expect((await request(app).post(`/api/orders/${retry.body.id}/payment`)).status).toBe(409);
  });

  test('accepting captures the payment; full lifecycle is tracked', async () => {
    const { body: order } = await place();
    for (const status of ['ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const res = await setStatus(order.id, status);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe(status);
    }
    const tracked = await request(app).get(`/api/orders/${order.id}`);
    expect(tracked.body.payment.status).toBe('CAPTURED');
    expect(tracked.body.statusHistory.map((h) => h.status)).toEqual([
      'PAYMENT_PENDING', 'PLACED', 'ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED',
    ]);
    expect(payments.calls.filter((c) => c[0] === 'capture')).toHaveLength(1);
  });

  test('accept fails with 503 and order stays PLACED when Payment Service is down', async () => {
    const { body: order } = await place();
    payments.mode = 'down';
    const res = await setStatus(order.id, 'ACCEPTED');
    expect(res.status).toBe(503);
    expect((await request(app).get(`/api/orders/${order.id}`)).body.status).toBe('PLACED');
  });

  test('rejects invalid status transitions and manual PLACED/CANCELLED', async () => {
    const { body: order } = await place();
    expect((await setStatus(order.id, 'DELIVERED')).status).toBe(409);
    expect((await setStatus(order.id, 'CANCELLED')).status).toBe(400);
    expect((await setStatus(order.id, 'PLACED')).status).toBe(400);
    expect((await setStatus('ord-none', 'ACCEPTED')).status).toBe(404);
  });

  test('cancel voids an authorized payment and refunds a captured one', async () => {
    const { body: a } = await place();
    const voided = await request(app).post(`/api/orders/${a.id}/cancel`).send({ reason: 'changed my mind' });
    expect(voided.body.status).toBe('CANCELLED');
    expect(voided.body.payment.status).toBe('VOIDED');

    const { body: b } = await place();
    await setStatus(b.id, 'ACCEPTED');
    const refunded = await request(app).post(`/api/orders/${b.id}/cancel`);
    expect(refunded.body.payment.status).toBe('REFUNDED');
    expect((await request(app).post(`/api/orders/${b.id}/cancel`)).status).toBe(409);
  });

  test('cannot cancel once the order is being prepared', async () => {
    const { body: order } = await place();
    await setStatus(order.id, 'ACCEPTED');
    await setStatus(order.id, 'PREPARING');
    const res = await request(app).post(`/api/orders/${order.id}/cancel`);
    expect(res.status).toBe(409);
    expect(payments.calls.filter((c) => c[0] === 'refund')).toHaveLength(0);
  });

  test('cancelling a PAYMENT_PENDING order voids a payment the Order Service never heard about', async () => {
    payments.mode = 'down';
    const { body } = await place();
    payments.mode = 'ok';
    // Simulate: the authorize succeeded on the Payment Service but the response was lost.
    await payments.authorize({ orderId: body.order.id, amount: body.order.totalAmount, method: 'UPI' });
    const res = await request(app).post(`/api/orders/${body.order.id}/cancel`);
    expect(res.body.status).toBe('CANCELLED');
    expect(res.body.payment.status).toBe('VOIDED');
  });

  test('lists order history by customer and status; menu is browsable', async () => {
    await place();
    await place({ ...ORDER, customerId: 'cust-7' });
    const res = await request(app).get('/api/orders?customerId=cust-2025MT03141&status=PLACED');
    expect(res.body).toHaveLength(1);
    expect(res.body[0].customerId).toBe('cust-2025MT03141');
    const menu = await request(app).get('/api/orders/menu');
    expect(menu.body.map((r) => r.id)).toEqual(['rest-001', 'rest-002']);
  });
});
