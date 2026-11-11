const request = require('supertest');
const { newDb } = require('pg-mem');
const { createApp } = require('../src/app');
const { initSchema } = require('../src/db');
const { createGateway } = require('../src/gateway');

const PAYMENT = {
  orderId: 'ord-1001',
  customerId: 'cust-2025MT03141',
  amount: 678,
  currency: 'INR',
  method: 'UPI',
};

let app;
let pool;

beforeEach(async () => {
  const { Pool } = newDb().adapters.createPg();
  pool = new Pool();
  await initSchema(pool);
  app = createApp(pool, createGateway({ limit: 10000, walletBalance: 2000 }));
});

afterEach(() => pool.end());

describe('Payment Service', () => {
  test('GET /health reports UP', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ service: 'payment-service', status: 'UP', db: 'UP' });
  });

  test('authorizes a payment and records the ledger entry', async () => {
    const res = await request(app).post('/api/payments').send(PAYMENT);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('AUTHORIZED');
    expect(res.body.amount).toBe(678);
    expect(res.body.gatewayRef).toMatch(/^gw-/);
    expect(res.body.transactions).toEqual([expect.objectContaining({ type: 'AUTHORIZE', status: 'SUCCESS' })]);
  });

  test('authorize is idempotent per orderId', async () => {
    const first = await request(app).post('/api/payments').send(PAYMENT);
    const again = await request(app).post('/api/payments').send(PAYMENT);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const list = await request(app).get(`/api/payments?orderId=${PAYMENT.orderId}`);
    expect(list.body).toHaveLength(1);
  });

  test('rejects a second payment for the same order with a different amount', async () => {
    await request(app).post('/api/payments').send(PAYMENT);
    const res = await request(app).post('/api/payments').send({ ...PAYMENT, amount: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('DUPLICATE_ORDER_PAYMENT');
  });

  test('rejects invalid payloads', async () => {
    expect((await request(app).post('/api/payments').send({ orderId: 'o' })).status).toBe(400);
    expect((await request(app).post('/api/payments').send({ ...PAYMENT, amount: -5 })).status).toBe(400);
    expect((await request(app).post('/api/payments').send({ ...PAYMENT, method: 'CASH' })).status).toBe(400);
    expect((await request(app).post('/api/payments').send({ ...PAYMENT, method: 'CARD' })).status).toBe(400);
    expect((await request(app).post('/api/payments').send({ ...PAYMENT, currency: 'USD' })).status).toBe(400);
  });

  test('declines by gateway rules with 402', async () => {
    const card = await request(app).post('/api/payments')
      .send({ ...PAYMENT, orderId: 'ord-c', method: 'CARD', cardLast4: '0000' });
    expect(card.status).toBe(402);
    expect(card.body.payment.status).toBe('DECLINED');
    expect(card.body.payment.failureReason).toBe('CARD_DECLINED_BY_ISSUER');

    const wallet = await request(app).post('/api/payments')
      .send({ ...PAYMENT, orderId: 'ord-w', method: 'WALLET', amount: 2500 });
    expect(wallet.body.payment.failureReason).toBe('INSUFFICIENT_WALLET_BALANCE');

    const limit = await request(app).post('/api/payments').send({ ...PAYMENT, orderId: 'ord-l', amount: 15000 });
    expect(limit.body.payment.failureReason).toBe('AMOUNT_LIMIT_EXCEEDED');

    // Retrying a declined order replays the decline instead of charging again.
    const replay = await request(app).post('/api/payments')
      .send({ ...PAYMENT, orderId: 'ord-c', method: 'CARD', cardLast4: '0000' });
    expect(replay.status).toBe(402);
    expect(replay.body.payment.id).toBe(card.body.payment.id);
  });

  test('captures then refunds; both are idempotent', async () => {
    const { body: p } = await request(app).post('/api/payments').send(PAYMENT);
    const cap = await request(app).post(`/api/payments/${p.id}/capture`);
    expect(cap.body.status).toBe('CAPTURED');
    expect((await request(app).post(`/api/payments/${p.id}/capture`)).body.status).toBe('CAPTURED');

    const ref = await request(app).post(`/api/payments/${p.id}/refund`).send({ reason: 'customer cancelled' });
    expect(ref.body.status).toBe('REFUNDED');
    expect(ref.body.refundReason).toBe('customer cancelled');
    expect((await request(app).post(`/api/payments/${p.id}/refund`)).body.status).toBe('REFUNDED');
    expect(ref.body.transactions.map((t) => t.type)).toEqual(['AUTHORIZE', 'CAPTURE', 'REFUND']);
  });

  test('refund before capture voids the authorization', async () => {
    const { body: p } = await request(app).post('/api/payments').send(PAYMENT);
    const res = await request(app).post(`/api/payments/${p.id}/refund`);
    expect(res.body.status).toBe('VOIDED');
  });

  test('rejects invalid payment state changes with 409', async () => {
    const { body: p } = await request(app).post('/api/payments').send(PAYMENT);
    await request(app).post(`/api/payments/${p.id}/refund`);
    const cap = await request(app).post(`/api/payments/${p.id}/capture`);
    expect(cap.status).toBe(409);
    expect(cap.body.error).toBe('INVALID_PAYMENT_STATE');

    const declined = await request(app).post('/api/payments')
      .send({ ...PAYMENT, orderId: 'ord-x', amount: 20000 });
    expect((await request(app).post(`/api/payments/${declined.body.payment.id}/capture`)).status).toBe(409);
  });

  test('returns 404 for unknown payment', async () => {
    expect((await request(app).get('/api/payments/pay-nope')).status).toBe(404);
    expect((await request(app).post('/api/payments/pay-nope/capture')).status).toBe(404);
  });

  test('lists payments by customer and status', async () => {
    await request(app).post('/api/payments').send(PAYMENT);
    await request(app).post('/api/payments').send({ ...PAYMENT, orderId: 'ord-2', customerId: 'cust-other' });
    const mine = await request(app).get('/api/payments?customerId=cust-2025MT03141&status=AUTHORIZED');
    expect(mine.body).toHaveLength(1);
    expect(mine.body[0].orderId).toBe('ord-1001');
  });
});
