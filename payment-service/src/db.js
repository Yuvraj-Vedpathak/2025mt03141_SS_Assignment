const { Pool } = require('pg');

function createPool() {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'payment_user',
    password: process.env.DB_PASSWORD || 'payment_pass',
    database: process.env.DB_NAME || 'payment_db',
    max: 10,
  });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS payments (
    id               TEXT PRIMARY KEY,
    order_id         TEXT NOT NULL UNIQUE,
    customer_id      TEXT NOT NULL,
    amount           NUMERIC(10,2) NOT NULL,
    currency         TEXT NOT NULL,
    method           TEXT NOT NULL,
    card_last4       TEXT,
    status           TEXT NOT NULL,
    gateway_ref      TEXT,
    failure_reason   TEXT,
    refund_reason    TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS payment_transactions (
    id          SERIAL PRIMARY KEY,
    payment_id  TEXT NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
    type        TEXT NOT NULL,
    amount      NUMERIC(10,2) NOT NULL,
    status      TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

async function initSchema(pool) {
  await pool.query(SCHEMA);
}

// Retries the initial connection so the service survives the DB pod starting later.
async function waitForDb(pool, retries = 20, delayMs = 3000) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] not ready (attempt ${attempt}/${retries}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database not reachable');
}

module.exports = { createPool, initSchema, waitForDb };
