const { createApp } = require('./app');
const { createPool, initSchema, waitForDb } = require('./db');

const PORT = parseInt(process.env.PORT || '3003', 10);

async function main() {
  const pool = createPool();
  await waitForDb(pool);
  await initSchema(pool);

  const server = createApp(pool).listen(PORT, () => {
    console.log(`[payment-service] listening on port ${PORT}`);
  });

  const shutdown = () => {
    console.log('[payment-service] shutting down');
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('[payment-service] failed to start:', err);
  process.exit(1);
});
