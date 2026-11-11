const { Pool } = require('pg');

function createPool() {
  return new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'order_user',
    password: process.env.DB_PASSWORD || 'order_pass',
    database: process.env.DB_NAME || 'order_db',
    max: 10,
  });
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    customer_id      TEXT NOT NULL,
    restaurant_id    TEXT NOT NULL,
    restaurant_name  TEXT NOT NULL,
    delivery_address TEXT NOT NULL,
    status           TEXT NOT NULL,
    total_amount     NUMERIC(10,2) NOT NULL,
    payment_method   TEXT NOT NULL,
    payment_id       TEXT,
    payment_status   TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS order_items (
    id            SERIAL PRIMARY KEY,
    order_id      TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    menu_item_id  TEXT NOT NULL,
    name          TEXT NOT NULL,
    unit_price    NUMERIC(10,2) NOT NULL,
    quantity      INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_status_history (
    id          SERIAL PRIMARY KEY,
    order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    status      TEXT NOT NULL,
    note        TEXT,
    changed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
