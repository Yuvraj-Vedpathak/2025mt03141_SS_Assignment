// Payment lifecycle.
//   AUTHORIZED -> CAPTURED  (restaurant accepted the order)
//   AUTHORIZED -> VOIDED    (order cancelled before capture: hold released, no money moved)
//   CAPTURED   -> REFUNDED  (order cancelled after capture: money returned)
//   DECLINED is terminal.
const TRANSITIONS = {
  AUTHORIZED: ['CAPTURED', 'VOIDED'],
  CAPTURED: ['REFUNDED'],
  DECLINED: [],
  VOIDED: [],
  REFUNDED: [],
};
const STATUSES = Object.keys(TRANSITIONS);
const METHODS = ['UPI', 'CARD', 'WALLET', 'NETBANKING'];

function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

module.exports = { TRANSITIONS, STATUSES, METHODS, canTransition };
