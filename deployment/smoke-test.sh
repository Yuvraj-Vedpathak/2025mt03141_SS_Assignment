#!/usr/bin/env bash
# FoodExpress - end-to-end smoke test against the cluster (use during demo video)
# 2025MT03141 / Yuvraj Vijay Vedpathak
# Usage: ./smoke-test.sh [ORDER_URL] [PAYMENT_URL]
set -euo pipefail

IP="$(minikube ip 2>/dev/null || echo localhost)"
O="${1:-http://$IP:30002}"
P="${2:-http://$IP:30003}"
J='Content-Type: application/json'

show() { echo; echo "### $1"; shift; curl -s "$@"; echo; }
id_of() { sed -E 's/^\{"id":"(ord-[a-z0-9]+)".*/\1/; s/.*"order":\{"id":"(ord-[a-z0-9]+)".*/\1/'; }
pay_of() { sed -E 's/.*"paymentId":"(pay-[a-z0-9]+)".*/\1/'; }

show "Health - order-service" "$O/health"
show "Health - payment-service" "$P/health"
show "Query: browseMenu" "$O/api/orders/menu"

ORDER=$(curl -s -X POST "$O/api/orders" -H "$J" -d '{
  "customerId": "cust-2025MT03141",
  "restaurantId": "rest-001",
  "deliveryAddress": "BITS Pilani WILP, Pune",
  "paymentMethod": "UPI",
  "items": [{"menuItemId":"item-101","quantity":2},{"menuItemId":"item-102","quantity":4}]
}')
echo; echo "### Command: placeOrder (order-service -> payment-service authorize)"; echo "$ORDER"
ID=$(echo "$ORDER" | id_of)
PAY=$(echo "$ORDER" | pay_of)

for s in ACCEPTED PREPARING OUT_FOR_DELIVERY DELIVERED; do
  show "Command: updateOrderStatus -> $s" -X PATCH "$O/api/orders/$ID/status" -H "$J" -d "{\"status\":\"$s\"}"
done

show "Query: trackOrder $ID" "$O/api/orders/$ID"
show "Query: getPayment $PAY (expect CAPTURED, ledger AUTHORIZE+CAPTURE)" "$P/api/payments/$PAY"

C=$(curl -s -X POST "$O/api/orders" -H "$J" -d '{"customerId":"cust-2025MT03141","restaurantId":"rest-002","deliveryAddress":"Pune","paymentMethod":"WALLET","items":[{"menuItemId":"item-201","quantity":1}]}')
CID=$(echo "$C" | id_of)
show "Command: cancelOrder $CID (payment-service voids the authorization)" -X POST "$O/api/orders/$CID/cancel" -H "$J" -d '{"reason":"changed my mind"}'

show "Negative: card declined by gateway (expect 402, order PAYMENT_FAILED)" -X POST "$O/api/orders" -H "$J" \
  -d '{"customerId":"cust-2025MT03141","restaurantId":"rest-001","deliveryAddress":"Pune","paymentMethod":"CARD","cardLast4":"0000","items":[{"menuItemId":"item-103","quantity":1}]}'
show "Negative: unavailable item (expect 422)" -X POST "$O/api/orders" -H "$J" \
  -d '{"customerId":"c1","restaurantId":"rest-001","deliveryAddress":"x","paymentMethod":"UPI","items":[{"menuItemId":"item-104","quantity":1}]}'
show "Negative: invalid transition (expect 409)" -X PATCH "$O/api/orders/$ID/status" -H "$J" -d '{"status":"ACCEPTED"}'
show "Query: payments of cust-2025MT03141" "$P/api/payments?customerId=cust-2025MT03141"
