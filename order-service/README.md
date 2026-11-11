# Order Service — FoodExpress
*2025MT03141 / Yuvraj Vijay Vedpathak*

Owns orders and their lifecycle (PAYMENT_PENDING → PLACED → ACCEPTED → PREPARING → OUT_FOR_DELIVERY → DELIVERED, or PAYMENT_FAILED / CANCELLED). Prices are computed on the server from the menu catalog. The service calls the **Payment Service** over REST:

* `placeOrder` → `POST /api/payments` (authorize)
* `ACCEPTED` → `POST /api/payments/{id}/capture`
* `cancelOrder` → `POST /api/payments/{id}/refund` (void or refund)

* **Stack:** Node.js 18, Express, axios, PostgreSQL (`order_db`)
* **Port:** 3002

```bash
npm install && npm test              # 13 tests, Payment Service stubbed
docker compose up --build            # expects Payment Service on host :3003
kubectl apply -f k8s/                # namespace foodexpress must exist
```

| Env var | Default |
|---|---|
| PORT | 3002 |
| DB_HOST / DB_PORT | localhost / 5432 |
| DB_USER / DB_PASSWORD / DB_NAME | order_user / order_pass / order_db |
| PAYMENT_SERVICE_URL | http://localhost:3003 (K8s: http://payment-service:3003) |
| PAYMENT_TIMEOUT_MS | 3000 |
