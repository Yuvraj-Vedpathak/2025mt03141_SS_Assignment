const express = require('express');
const { randomUUID } = require('crypto');
const { METHODS, TRANSITIONS, canTransition } = require('../paymentStatus');

function badRequest(res, message) {
  return res.status(400).json({ error: 'BAD_REQUEST', message });
}

function notFound(res, message) {
  return res.status(404).json({ error: 'NOT_FOUND', message });
}

function toPayment(row, transactions) {
  return {
    id: row.id,
    orderId: row.order_id,
    customerId: row.customer_id,
    amount: Number(row.amount),
    currency: row.currency,
    method: row.method,
    cardLast4: row.card_last4 || undefined,
    status: row.status,
    gatewayRef: row.gateway_ref || undefined,
    failureReason: row.failure_reason || undefined,
    refundReason: row.refund_reason || undefined,
    transactions: transactions
      ? transactions.map((t) => ({ type: t.type, amount: Number(t.amount), status: t.status, at: t.created_at }))
      : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = function paymentRoutes(pool, gateway) {
  const router = express.Router();

  async function loadPayment(where, value) {
    const { rows } = await pool.query(`SELECT * FROM payments WHERE ${where} = $1`, [value]);
    if (!rows[0]) return null;
    const tx = await pool.query('SELECT * FROM payment_transactions WHERE payment_id = $1 ORDER BY id', [rows[0].id]);
    return toPayment(rows[0], tx.rows);
  }

  // Replies for an existing payment of the same order (idempotent authorize).
  function replyExisting(res, existing, amount) {
    if (existing.amount !== amount) {
      return res.status(409).json({
        error: 'DUPLICATE_ORDER_PAYMENT',
        message: `Order ${existing.orderId} already has payment ${existing.id} for ${existing.amount}`,
        payment: existing,
      });
    }
    if (existing.status === 'DECLINED') {
      return res.status(402).json({ error: 'PAYMENT_DECLINED', message: existing.failureReason, payment: existing });
    }
    return res.status(200).json(existing);
  }

  // Moves a payment between states in one local transaction and appends a ledger entry.
  async function transition(payment, to, type, extra = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE payments SET status = $1, refund_reason = COALESCE($2, refund_reason), updated_at = NOW()
          WHERE id = $3 AND status = $4`,
        [to, extra.refundReason || null, payment.id, payment.status]
      );
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query(
        'INSERT INTO payment_transactions (payment_id, type, amount, status) VALUES ($1, $2, $3, $4)',
        [payment.id, type, payment.amount, 'SUCCESS']
      );
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  // COMMAND: authorizePayment (called by the Order Service on placeOrder).
  // Idempotent per orderId: a retry for the same order returns the original payment.
  router.post('/', async (req, res, next) => {
    try {
      const { orderId, customerId, method, cardLast4 } = req.body || {};
      const currency = (req.body && req.body.currency) || 'INR';
      const amount = Number(req.body && req.body.amount);
      if (!orderId || !customerId) return badRequest(res, 'orderId and customerId are required');
      if (!Number.isFinite(amount) || amount <= 0) return badRequest(res, 'amount must be a positive number');
      if (Math.round(amount * 100) !== amount * 100) return badRequest(res, 'amount can have at most 2 decimals');
      if (currency !== 'INR') return badRequest(res, 'only INR is supported');
      if (!METHODS.includes(method)) return badRequest(res, `method must be one of ${METHODS.join(', ')}`);
      if (method === 'CARD' && !/^\d{4}$/.test(String(cardLast4 || ''))) {
        return badRequest(res, 'cardLast4 (4 digits) is required for CARD payments');
      }

      const existing = await loadPayment('order_id', orderId);
      if (existing) return replyExisting(res, existing, amount);

      const result = gateway.authorize({ amount, method, cardLast4: cardLast4 && String(cardLast4) });
      const id = `pay-${randomUUID().slice(0, 8)}`;
      const status = result.approved ? 'AUTHORIZED' : 'DECLINED';

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO payments (id, order_id, customer_id, amount, currency, method, card_last4, status, gateway_ref, failure_reason)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, orderId, customerId, amount, currency, method, method === 'CARD' ? String(cardLast4) : null,
            status, result.reference || null, result.reason || null]
        );
        await client.query(
          'INSERT INTO payment_transactions (payment_id, type, amount, status) VALUES ($1, $2, $3, $4)',
          [id, 'AUTHORIZE', amount, result.approved ? 'SUCCESS' : 'FAILED']
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        // Two concurrent authorize calls for the same order: the UNIQUE(order_id) loser returns the winner's payment.
        if (err.code === '23505') {
          const winner = await loadPayment('order_id', orderId);
          if (winner) return replyExisting(res, winner, amount);
        }
        throw err;
      } finally {
        client.release();
      }

      const payment = await loadPayment('id', id);
      if (!result.approved) {
        return res.status(402).json({ error: 'PAYMENT_DECLINED', message: result.reason, payment });
      }
      res.status(201).json(payment);
    } catch (err) {
      next(err);
    }
  });

  // QUERY: listPayments (by orderId, customerId and/or status)
  router.get('/', async (req, res, next) => {
    try {
      const clauses = [];
      const params = [];
      for (const [param, column] of [['orderId', 'order_id'], ['customerId', 'customer_id'], ['status', 'status']]) {
        if (req.query[param]) {
          params.push(req.query[param]);
          clauses.push(`${column} = $${params.length}`);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT * FROM payments ${where} ORDER BY created_at DESC`, params);
      res.json(rows.map((r) => toPayment(r)));
    } catch (err) {
      next(err);
    }
  });

  // QUERY: getPayment (with its transaction ledger)
  router.get('/:id', async (req, res, next) => {
    try {
      const payment = await loadPayment('id', req.params.id);
      if (!payment) return notFound(res, `Payment ${req.params.id} not found`);
      res.json(payment);
    } catch (err) {
      next(err);
    }
  });

  // COMMAND: capturePayment (called by the Order Service when the restaurant accepts the order).
  // Idempotent: capturing an already captured payment returns it unchanged.
  router.post('/:id/capture', async (req, res, next) => {
    try {
      const payment = await loadPayment('id', req.params.id);
      if (!payment) return notFound(res, `Payment ${req.params.id} not found`);
      if (payment.status === 'CAPTURED') return res.json(payment);
      if (!canTransition(payment.status, 'CAPTURED') || !(await transition(payment, 'CAPTURED', 'CAPTURE'))) {
        return conflict(res, payment, 'CAPTURED');
      }
      res.json(await loadPayment('id', payment.id));
    } catch (err) {
      next(err);
    }
  });

  // COMMAND: refundPayment (compensation when an order is cancelled).
  // AUTHORIZED -> VOIDED (hold released), CAPTURED -> REFUNDED. Idempotent for VOIDED/REFUNDED.
  router.post('/:id/refund', async (req, res, next) => {
    try {
      const payment = await loadPayment('id', req.params.id);
      if (!payment) return notFound(res, `Payment ${req.params.id} not found`);
      if (payment.status === 'VOIDED' || payment.status === 'REFUNDED') return res.json(payment);
      const to = payment.status === 'CAPTURED' ? 'REFUNDED' : 'VOIDED';
      const reason = (req.body && req.body.reason) || 'order cancelled';
      if (!canTransition(payment.status, to) ||
          !(await transition(payment, to, to === 'REFUNDED' ? 'REFUND' : 'VOID', { refundReason: reason }))) {
        return conflict(res, payment, to);
      }
      res.json(await loadPayment('id', payment.id));
    } catch (err) {
      next(err);
    }
  });

  function conflict(res, payment, to) {
    return res.status(409).json({
      error: 'INVALID_PAYMENT_STATE',
      message: `Cannot move payment ${payment.id} from ${payment.status} to ${to}`,
      allowed: TRANSITIONS[payment.status],
      payment,
    });
  }

  return router;
};


