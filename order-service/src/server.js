const { createApp } = require('./app');
const { createPool, initSchema, waitForDb } = require('./db');
const { createPaymentClient } = require('./paymentClient');

const PORT = parseInt(process.env.PORT || '3002', 10);

async function main() {
  const pool = createPool();
  await waitForDb(pool);
  await initSchema(pool);

  const paymentClient = createPaymentClient();
  const server = createApp(pool, paymentClient).listen(PORT, () => {
    console.log(`[order-service] listening on port ${PORT}`);
    console.log(`[order-service] payment service at ${process.env.PAYMENT_SERVICE_URL || 'http://localhost:3003'}`);
  });

  const shutdown = () => {
    console.log('[order-service] shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[order-service] failed to start:', err);
  process.exit(1);
});
