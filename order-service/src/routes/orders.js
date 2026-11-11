const express = require('express');
const { randomUUID } = require('crypto');
const { MANUAL_STATUSES, PAYMENT_METHODS, TRANSITIONS, canTransition } = require('../orderStatus');
const { priceItems, listMenu } = require('../catalog');
const { PaymentServiceUnavailable, PaymentDeclined, PaymentConflict } = require('../paymentClient');

function badRequest(res, message, details) {
  return res.status(400).json({ error: 'BAD_REQUEST', message, details });
}

function notFound(res, message) {
  return res.status(404).json({ error: 'NOT_FOUND', message });
}

function unavailable(res, err, extra = {}) {
  return res.status(503).json({ error: 'SERVICE_UNAVAILABLE', message: err.message, ...extra });
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function toOrder(row, items, history) {
  return {
    id: row.id,
    customerId: row.customer_id,
    restaurantId: row.restaurant_id,
    restaurantName: row.restaurant_name,
    deliveryAddress: row.delivery_address,
    status: row.status,
    totalAmount: Number(row.total_amount),
    payment: {
      method: row.payment_method,
      paymentId: row.payment_id,
      status: row.payment_status,
    },
    items: items.map((i) => ({
      menuItemId: i.menu_item_id,
      name: i.name,
      unitPrice: Number(i.unit_price),
      quantity: i.quantity,
      lineTotal: round2(Number(i.unit_price) * i.quantity),
    })),
    statusHistory: history.map((h) => ({ status: h.status, note: h.note || undefined, changedAt: h.changed_at })),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

module.exports = function orderRoutes(pool, paymentClient) {
  const router = express.Router();

  async function loadOrder(id) {
    const { rows } = await pool.query('SELECT * FROM orders WHERE id = $1', [id]);
    if (!rows[0]) return null;
    const items = await pool.query('SELECT * FROM order_items WHERE order_id = $1 ORDER BY id', [id]);
    const history = await pool.query('SELECT * FROM order_status_history WHERE order_id = $1 ORDER BY id', [id]);
    return toOrder(rows[0], items.rows, history.rows);
  }

  // Moves an order from `from` to `to` in one local transaction and records the history entry.
  // The UPDATE is conditional on the current status, so a concurrent change makes it a no-op (returns false).
  async function transition(id, from, to, { paymentId, paymentStatus, note } = {}) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE orders
            SET status = $1,
                payment_id = COALESCE($2, payment_id),
                payment_status = COALESCE($3, payment_status),
                updated_at = NOW()
          WHERE id = $4 AND status = $5`,
        [to, paymentId || null, paymentStatus || null, id, from]
      );
      if (result.rowCount !== 1) {
        await client.query('ROLLBACK');
        return false;
      }
      await client.query('INSERT INTO order_status_history (order_id, status, note) VALUES ($1, $2, $3)', [
        id,
        to,
        note || null,
      ]);
      await client.query('COMMIT');
      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  function invalidTransition(res, from, to, message) {
    return res.status(409).json({
      error: 'INVALID_TRANSITION',
      message: message || `Cannot move order from ${from} to ${to}`,
      allowed: TRANSITIONS[from],
    });
  }

  // Saga step 2: ask the Payment Service to authorize the order total, then record the outcome locally.
  // Returns the HTTP status to send: 201 PLACED, 402 PAYMENT_FAILED, 503 still PAYMENT_PENDING.
  async function authorizePayment(order, cardLast4) {
    try {
      const payment = await paymentClient.authorize({
        orderId: order.id,
        customerId: order.customerId,
        amount: order.totalAmount,
        method: order.payment.method,
        cardLast4,
      });
      await transition(order.id, 'PAYMENT_PENDING', 'PLACED', {
        paymentId: payment.id,
        paymentStatus: payment.status,
        note: `payment ${payment.id} authorized`,
      });
      return { status: 201 };
    } catch (err) {
      if (err instanceof PaymentDeclined) {
        await transition(order.id, 'PAYMENT_PENDING', 'PAYMENT_FAILED', {
          paymentId: err.payment.id,
          paymentStatus: 'DECLINED',
          note: err.payment.failureReason,
        });
        return { status: 402, error: 'PAYMENT_DECLINED', message: err.message };
      }
      if (err instanceof PaymentConflict) {
        return { status: 409, error: 'PAYMENT_CONFLICT', message: err.message };
      }
      if (err instanceof PaymentServiceUnavailable) {
        return { status: 503, error: 'SERVICE_UNAVAILABLE', message: `${err.message}. Retry with POST /api/orders/${order.id}/payment` };
      }
      throw err;
    }
  }

  async function respondAfterPayment(res, orderId, outcome) {
    const order = await loadOrder(orderId);
    if (outcome.status < 300) return res.status(outcome.status).json(order);
    return res.status(outcome.status).json({ error: outcome.error, message: outcome.message, order });
  }

  // QUERY: browseMenu (local read-only catalog used for pricing)
  router.get('/menu', (req, res) => res.json(listMenu()));

  // COMMAND: placeOrder
  // 1) price items on the server, 2) store the order as PAYMENT_PENDING,
  // 3) call the Payment Service synchronously to authorize, 4) mark PLACED or PAYMENT_FAILED.
  router.post('/', async (req, res, next) => {
    try {
      const { customerId, restaurantId, deliveryAddress, items, paymentMethod, cardLast4 } = req.body || {};
      if (!customerId || !restaurantId || !deliveryAddress) {
        return badRequest(res, 'customerId, restaurantId and deliveryAddress are required');
      }
      if (!Array.isArray(items) || items.length === 0) {
        return badRequest(res, 'items must be a non-empty array of { menuItemId, quantity }');
      }
      if (!PAYMENT_METHODS.includes(paymentMethod)) {
        return badRequest(res, `paymentMethod must be one of ${PAYMENT_METHODS.join(', ')}`);
      }
      if (paymentMethod === 'CARD' && !/^\d{4}$/.test(String(cardLast4 || ''))) {
        return badRequest(res, 'cardLast4 (4 digits) is required for CARD payments');
      }

      const priced = priceItems(restaurantId, items);
      if (priced.notFound) return notFound(res, `Restaurant ${restaurantId} not found`);
      if (priced.errors.length) {
        return res.status(422).json({
          error: 'ORDER_REJECTED',
          message: 'Order items could not be validated',
          details: priced.errors,
        });
      }

      const total = round2(priced.items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0));
      const id = `ord-${randomUUID().slice(0, 8)}`;

      // Saga step 1 (local transaction): persist the order before any remote call.
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO orders (id, customer_id, restaurant_id, restaurant_name, delivery_address,
                               status, total_amount, payment_method)
           VALUES ($1, $2, $3, $4, $5, 'PAYMENT_PENDING', $6, $7)`,
          [id, customerId, restaurantId, priced.restaurantName, deliveryAddress, total, paymentMethod]
        );
        for (const i of priced.items) {
          await client.query(
            `INSERT INTO order_items (order_id, menu_item_id, name, unit_price, quantity)
             VALUES ($1, $2, $3, $4, $5)`,
            [id, i.menuItemId, i.name, i.unitPrice, i.quantity]
          );
        }
        await client.query('INSERT INTO order_status_history (order_id, status) VALUES ($1, $2)', [id, 'PAYMENT_PENDING']);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const order = await loadOrder(id);
      const outcome = await authorizePayment(order, cardLast4);
      return respondAfterPayment(res, id, outcome);
    } catch (err) {
      next(err);
    }
  });

  // COMMAND: retryPayment - for an order left in PAYMENT_PENDING because the Payment Service was down.
  // Safe to repeat: the Payment Service's authorize is idempotent per orderId.
  router.post('/:id/payment', async (req, res, next) => {
    try {
      const order = await loadOrder(req.params.id);
      if (!order) return notFound(res, `Order ${req.params.id} not found`);
      if (order.status !== 'PAYMENT_PENDING') {
        return invalidTransition(res, order.status, 'PLACED', `Order is ${order.status}; only PAYMENT_PENDING orders can retry payment`);
      }
      const outcome = await authorizePayment(order, (req.body || {}).cardLast4);
      return respondAfterPayment(res, order.id, outcome.status === 201 ? { status: 200 } : outcome);
    } catch (err) {
      next(err);
    }
  });

  // QUERY: getOrderHistory (by customer and/or restaurant, optional status)
  router.get('/', async (req, res, next) => {
    try {
      const clauses = [];
      const params = [];
      for (const [param, column] of [['customerId', 'customer_id'], ['restaurantId', 'restaurant_id'], ['status', 'status']]) {
        if (req.query[param]) {
          params.push(req.query[param]);
          clauses.push(`${column} = $${params.length}`);
        }
      }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const { rows } = await pool.query(`SELECT id FROM orders ${where} ORDER BY created_at DESC`, params);
      const orders = [];
      for (const r of rows) orders.push(await loadOrder(r.id));
      res.json(orders);
    } catch (err) {
      next(err);
    }
  });

  // QUERY: trackOrder
  router.get('/:id', async (req, res, next) => {
    try {
      const order = await loadOrder(req.params.id);
      if (!order) return notFound(res, `Order ${req.params.id} not found`);
      res.json(order);
    } catch (err) {
      next(err);
    }
  });

  // COMMAND: updateOrderStatus (restaurant accepts / prepares, delivery agent delivers).
  // ACCEPTED captures the authorized payment through the Payment Service first.
  router.patch('/:id/status', async (req, res, next) => {
    try {
      const { status } = req.body || {};
      if (!MANUAL_STATUSES.includes(status)) {
        return badRequest(res, `status must be one of ${MANUAL_STATUSES.join(', ')} (use POST /cancel to cancel)`);
      }
      const order = await loadOrder(req.params.id);
      if (!order) return notFound(res, `Order ${req.params.id} not found`);
      if (!canTransition(order.status, status)) return invalidTransition(res, order.status, status);

      const extra = {};
      if (status === 'ACCEPTED') {
        try {
          const payment = await paymentClient.capture(order.payment.paymentId);
          extra.paymentStatus = payment.status;
          extra.note = `payment ${payment.id} captured`;
        } catch (err) {
          if (err instanceof PaymentServiceUnavailable) return unavailable(res, err, { status: order.status });
          if (err instanceof PaymentConflict) {
            return res.status(409).json({ error: 'PAYMENT_CONFLICT', message: err.message, payment: err.body });
          }
          throw err;
        }
      }

      if (!(await transition(order.id, order.status, status, extra))) {
        const current = await loadOrder(order.id);
        return invalidTransition(res, current.status, status, `Order changed concurrently; it is now ${current.status}`);
      }
      res.json(await loadOrder(order.id));
    } catch (err) {
      next(err);
    }
  });

  // COMMAND: cancelOrder - the compensating step of the saga.
  // An authorized payment is voided and a captured payment is refunded through the Payment Service.
  router.post('/:id/cancel', async (req, res, next) => {
    try {
      const order = await loadOrder(req.params.id);
      if (!order) return notFound(res, `Order ${req.params.id} not found`);
      if (!canTransition(order.status, 'CANCELLED')) {
        return invalidTransition(res, order.status, 'CANCELLED', `Order in status ${order.status} can no longer be cancelled`);
      }

      const extra = { note: (req.body && req.body.reason) || 'cancelled by customer' };
      try {
        // A PAYMENT_PENDING order may still have a payment if the authorize response was lost, so look it up.
        let paymentId = order.payment.paymentId;
        if (!paymentId && order.status === 'PAYMENT_PENDING') {
          const found = await paymentClient.findByOrder(order.id);
          paymentId = found && found.status === 'AUTHORIZED' ? found.id : null;
        }
        if (paymentId) {
          const payment = await paymentClient.refund(paymentId, extra.note);
          extra.paymentId = payment.id;
          extra.paymentStatus = payment.status;
          extra.note = `${extra.note}; payment ${payment.status.toLowerCase()}`;
        }
      } catch (err) {
        if (err instanceof PaymentServiceUnavailable) return unavailable(res, err, { status: order.status });
        if (err instanceof PaymentConflict) {
          return res.status(409).json({ error: 'PAYMENT_CONFLICT', message: err.message, payment: err.body });
        }
        throw err;
      }

      if (!(await transition(order.id, order.status, 'CANCELLED', extra))) {
        const current = await loadOrder(order.id);
        return invalidTransition(res, current.status, 'CANCELLED', `Order changed concurrently; it is now ${current.status}`);
      }
      res.json(await loadOrder(order.id));
    } catch (err) {
      next(err);
    }
  });

  return router;
};

