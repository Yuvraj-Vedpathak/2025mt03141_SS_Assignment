# Payment Service — FoodExpress
*2025MT03141 / Yuvraj Vijay Vedpathak*

Owns payments and their ledger. Payment lifecycle: AUTHORIZED → CAPTURED → REFUNDED, AUTHORIZED → VOIDED, or DECLINED. A simulated gateway (`src/gateway.js`) approves or declines payments using deterministic rules:

| Rule | Result |
|---|---|
| amount > `PAYMENT_LIMIT` (10000) | DECLINED `AMOUNT_LIMIT_EXCEEDED` |
| CARD with `cardLast4` = `0000` | DECLINED `CARD_DECLINED_BY_ISSUER` |
| WALLET with amount > `WALLET_BALANCE` (2000) | DECLINED `INSUFFICIENT_WALLET_BALANCE` |

Authorize is idempotent per `orderId`; capture and refund are idempotent per payment. This lets the Order Service retry safely.

* **Stack:** Node.js 18, Express, PostgreSQL (`payment_db`)
* **Port:** 3003

```bash
npm install && npm test              # 11 tests
docker compose up --build            # with its own Postgres
kubectl apply -f k8s/                # namespace foodexpress must exist
```

| Env var | Default |
|---|---|
| PORT | 3003 |
| DB_HOST / DB_PORT | localhost / 5432 |
| DB_USER / DB_PASSWORD / DB_NAME | payment_user / payment_pass / payment_db |
| PAYMENT_LIMIT / WALLET_BALANCE | 10000 / 2000 |
