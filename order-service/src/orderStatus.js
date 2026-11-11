// Order lifecycle state machine.
// PAYMENT_PENDING is the state while the Order Service waits for the Payment Service.
const TRANSITIONS = {
  PAYMENT_PENDING: ['PLACED', 'PAYMENT_FAILED', 'CANCELLED'],
  PAYMENT_FAILED: [],
  PLACED: ['ACCEPTED', 'CANCELLED'],
  ACCEPTED: ['PREPARING', 'CANCELLED'],
  PREPARING: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};

const STATUSES = Object.keys(TRANSITIONS);

// Statuses a restaurant / delivery agent may set through PATCH /api/orders/{id}/status.
// PLACED and PAYMENT_FAILED are only set by the payment step; CANCELLED has its own endpoint.
const MANUAL_STATUSES = ['ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED'];

const PAYMENT_METHODS = ['UPI', 'CARD', 'WALLET', 'NETBANKING'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { TRANSITIONS, STATUSES, MANUAL_STATUSES, PAYMENT_METHODS, canTransition };
