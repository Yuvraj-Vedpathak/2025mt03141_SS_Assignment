#!/usr/bin/env python3
"""FoodExpress command-line client and end-to-end test (Order Service + Payment Service).

2025MT03141 / Yuvraj Vijay Vedpathak

Uses only the Python standard library (Python 3.6+), so nothing to install.

Examples:
  python3 foodexpress_client.py demo                        # full flow with PASS/FAIL checks
  python3 foodexpress_client.py menu
  python3 foodexpress_client.py order rest-001 item-101:2 item-102:1 --method UPI
  python3 foodexpress_client.py order rest-001 item-103 --method CARD --card 0000   # declined
  python3 foodexpress_client.py advance ord-1a2b3c4d        # walk the order to DELIVERED
  python3 foodexpress_client.py track ord-1a2b3c4d
  python3 foodexpress_client.py cancel ord-1a2b3c4d
  python3 foodexpress_client.py retry-payment ord-1a2b3c4d
  python3 foodexpress_client.py payment pay-1a2b3c4d
  python3 foodexpress_client.py payments
  python3 foodexpress_client.py history

Service URLs default to http://localhost:3002 (order) and http://localhost:3003 (payment).
Override them with ORDER_URL / PAYMENT_URL, or with options placed before the command:
  python3 foodexpress_client.py --order-url http://192.168.49.2:30002 \\
                                --payment-url http://192.168.49.2:30003 demo
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

CUSTOMER = 'cust-2025MT03141'
ADDRESS = 'BITS Pilani WILP, Pune'
LIFECYCLE = ['PLACED', 'ACCEPTED', 'PREPARING', 'OUT_FOR_DELIVERY', 'DELIVERED']
METHODS = ['UPI', 'CARD', 'WALLET', 'NETBANKING']


class Api:
    """Thin wrapper around the Order and Payment service REST APIs."""

    def __init__(self, order_url, payment_url, timeout=15):
        self.order_url = order_url.rstrip('/')
        self.payment_url = payment_url.rstrip('/')
        self.timeout = timeout

    def call(self, method, url, body=None):
        """Returns (status, parsed JSON body). HTTP errors are returned, not raised."""
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(url, data=data, method=method,
                                     headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                return resp.status, json.loads(resp.read().decode() or 'null')
        except urllib.error.HTTPError as err:
            text = err.read().decode()
            try:
                return err.code, json.loads(text)
            except ValueError:
                return err.code, text

    # Order Service
    def health_order(self):
        return self.call('GET', self.order_url + '/health')

    def menu(self):
        return self.call('GET', self.order_url + '/api/orders/menu')

    def place_order(self, restaurant_id, items, method='UPI', card=None, customer_id=CUSTOMER, address=ADDRESS):
        body = {'customerId': customer_id, 'restaurantId': restaurant_id, 'deliveryAddress': address,
                'paymentMethod': method, 'items': items}
        if card:
            body['cardLast4'] = card
        return self.call('POST', self.order_url + '/api/orders', body)

    def set_status(self, order_id, status):
        return self.call('PATCH', '{}/api/orders/{}/status'.format(self.order_url, order_id), {'status': status})

    def track(self, order_id):
        return self.call('GET', '{}/api/orders/{}'.format(self.order_url, order_id))

    def history(self, customer_id=CUSTOMER):
        query = urllib.parse.urlencode({'customerId': customer_id})
        return self.call('GET', '{}/api/orders?{}'.format(self.order_url, query))

    def cancel(self, order_id, reason=None):
        return self.call('POST', '{}/api/orders/{}/cancel'.format(self.order_url, order_id),
                         {'reason': reason} if reason else {})

    def retry_payment(self, order_id):
        return self.call('POST', '{}/api/orders/{}/payment'.format(self.order_url, order_id), {})

    # Payment Service
    def health_payment(self):
        return self.call('GET', self.payment_url + '/health')

    def payment(self, payment_id):
        return self.call('GET', '{}/api/payments/{}'.format(self.payment_url, payment_id))

    def payments(self, **filters):
        query = urllib.parse.urlencode({k: v for k, v in filters.items() if v})
        return self.call('GET', '{}/api/payments{}'.format(self.payment_url, '?' + query if query else ''))


def show(title, status, body):
    print('### {} -> HTTP {}'.format(title, status))
    print(json.dumps(body, indent=2) if not isinstance(body, str) else body)
    print()


def parse_item(text):
    """'item-101:2' -> {'menuItemId': 'item-101', 'quantity': 2}; quantity defaults to 1."""
    item_id, _, qty = text.partition(':')
    try:
        quantity = int(qty) if qty else 1
    except ValueError:
        raise argparse.ArgumentTypeError('quantity must be a number: ' + text)
    return {'menuItemId': item_id, 'quantity': quantity}


class Checker:
    def __init__(self):
        self.passed = 0
        self.failed = 0

    def check(self, name, ok, detail=''):
        if ok:
            self.passed += 1
        else:
            self.failed += 1
        print('{}  {}{}'.format('PASS' if ok else 'FAIL', name, '  -> ' + detail if detail else ''))
        return ok


def payment_status(order):
    return (order.get('payment') or {}).get('status') if isinstance(order, dict) else None


def run_demo(api):
    """Exercises every operation end to end and reports PASS/FAIL per step."""
    c = Checker()

    s, b = api.health_order()
    c.check('order-service health', s == 200 and b.get('status') == 'UP', 'pod ' + str(b.get('pod')))
    s, b = api.health_payment()
    c.check('payment-service health', s == 200 and b.get('status') == 'UP', 'pod ' + str(b.get('pod')))

    s, menu = api.menu()
    rest = next((r for r in menu if r['id'] == 'rest-001'), None) if s == 200 else None
    available = [i for i in rest['items'] if i['available']] if rest else []
    c.check('browseMenu (rest-001)', len(available) >= 2, '{} available items'.format(len(available)))
    if len(available) < 2:
        return c

    items = [{'menuItemId': available[0]['id'], 'quantity': 2},
             {'menuItemId': available[1]['id'], 'quantity': 1}]
    expected = available[0]['price'] * 2 + available[1]['price']
    s, order = api.place_order('rest-001', items, 'UPI')
    ok = s == 201 and order.get('status') == 'PLACED' and order.get('totalAmount') == expected \
        and payment_status(order) == 'AUTHORIZED'
    c.check('placeOrder (order-service -> payment-service authorize)', ok,
            '{} total={} payment={}'.format(order.get('id'), order.get('totalAmount'), payment_status(order)))
    if s != 201:
        return c
    order_id, payment_id = order['id'], order['payment']['paymentId']

    s, p = api.payment(payment_id)
    c.check('Payment Service holds the authorization', s == 200 and p.get('status') == 'AUTHORIZED'
            and p.get('amount') == expected and p.get('orderId') == order_id, '{} {}'.format(payment_id, p.get('status')))

    for status in LIFECYCLE[1:]:
        s, b = api.set_status(order_id, status)
        detail = 'payment {}'.format(payment_status(b)) if status == 'ACCEPTED' else ''
        c.check('updateOrderStatus -> ' + status, s == 200 and b.get('status') == status, detail)

    s, b = api.track(order_id)
    history = [h['status'] for h in b.get('statusHistory', [])] if s == 200 else []
    c.check('trackOrder: full status history', history == ['PAYMENT_PENDING'] + LIFECYCLE, ' > '.join(history))

    s, p = api.payment(payment_id)
    ledger = [t['type'] for t in p.get('transactions', [])] if s == 200 else []
    c.check('payment captured on accept (ledger)', p.get('status') == 'CAPTURED' and ledger == ['AUTHORIZE', 'CAPTURE'],
            ' > '.join(ledger))

    s, b = api.history()
    c.check('getOrderHistory contains the order', s == 200 and any(o['id'] == order_id for o in b),
            '{} orders for {}'.format(len(b) if s == 200 else 0, CUSTOMER))

    s, b = api.set_status(order_id, 'ACCEPTED')
    c.check('invalid transition DELIVERED -> ACCEPTED is rejected', s == 409, 'HTTP {}'.format(s))

    # Cancel before accept -> authorization voided.
    s, b = api.place_order('rest-001', [{'menuItemId': available[0]['id'], 'quantity': 1}], 'WALLET')
    if c.check('place second order (to cancel)', s == 201, b.get('id', '') if s == 201 else str(b)):
        s, b = api.cancel(b['id'], 'changed my mind')
        c.check('cancelOrder voids the payment', s == 200 and b.get('status') == 'CANCELLED'
                and payment_status(b) == 'VOIDED', '{} / {}'.format(b.get('status'), payment_status(b)))

    # Cancel after accept -> captured payment refunded.
    s, b = api.place_order('rest-001', [{'menuItemId': available[1]['id'], 'quantity': 1}], 'NETBANKING')
    if s == 201:
        api.set_status(b['id'], 'ACCEPTED')
        s, b = api.cancel(b['id'], 'restaurant delay')
        c.check('cancel after accept refunds the payment', s == 200 and payment_status(b) == 'REFUNDED',
                str(payment_status(b)))

    s, b = api.place_order('rest-001', [{'menuItemId': available[0]['id'], 'quantity': 1}], 'CARD', '0000')
    c.check('declined card -> 402 and order PAYMENT_FAILED',
            s == 402 and isinstance(b, dict) and b.get('order', {}).get('status') == 'PAYMENT_FAILED',
            'HTTP {} {}'.format(s, b.get('message') if isinstance(b, dict) else b))

    s, b = api.place_order('rest-001', [{'menuItemId': 'item-201', 'quantity': 1}])
    c.check('item from another restaurant is rejected (422)', s == 422,
            'HTTP {} {}'.format(s, b.get('details') if isinstance(b, dict) else b))

    s, b = api.place_order('rest-does-not-exist', items)
    c.check('unknown restaurant is rejected (404)', s == 404, 'HTTP {}'.format(s))

    s, b = api.call('POST', api.order_url + '/api/orders', {'customerId': CUSTOMER})
    c.check('missing fields are rejected (400)', s == 400, 'HTTP {}'.format(s))

    s, b = api.payments(customerId=CUSTOMER)
    statuses = sorted({p['status'] for p in b}) if s == 200 else []
    c.check('listPayments shows every payment state', {'CAPTURED', 'VOIDED', 'REFUNDED', 'DECLINED'} <= set(statuses),
            ', '.join(statuses))
    return c


def main(argv=None):
    parser = argparse.ArgumentParser(description='FoodExpress client (2025MT03141 / Yuvraj Vijay Vedpathak)')
    parser.add_argument('--order-url', default=os.environ.get('ORDER_URL', 'http://localhost:3002'))
    parser.add_argument('--payment-url', default=os.environ.get('PAYMENT_URL', 'http://localhost:3003'))
    sub = parser.add_subparsers(dest='command')

    sub.add_parser('demo', help='run the full flow with PASS/FAIL checks')
    sub.add_parser('health', help='health of both services')
    sub.add_parser('menu', help='browse the menu used for pricing')
    p = sub.add_parser('order', help='place an order: order <restaurant_id> <item[:qty]> ...')
    p.add_argument('restaurant_id')
    p.add_argument('items', nargs='+', type=parse_item)
    p.add_argument('--method', choices=METHODS, default='UPI')
    p.add_argument('--card', help='last 4 digits for CARD (0000 is declined)')
    p.add_argument('--customer', default=CUSTOMER)
    p.add_argument('--address', default=ADDRESS)
    p = sub.add_parser('status', help='set an order status')
    p.add_argument('order_id')
    p.add_argument('status', choices=LIFECYCLE[1:])
    p = sub.add_parser('advance', help='move an order through every remaining status to DELIVERED')
    p.add_argument('order_id')
    sub.add_parser('track', help='track an order').add_argument('order_id')
    p = sub.add_parser('cancel', help='cancel an order (voids/refunds its payment)')
    p.add_argument('order_id')
    p.add_argument('--reason')
    sub.add_parser('retry-payment', help='retry payment of a PAYMENT_PENDING order').add_argument('order_id')
    p = sub.add_parser('history', help='order history of a customer')
    p.add_argument('--customer', default=CUSTOMER)
    sub.add_parser('payment', help='a payment with its ledger').add_argument('payment_id')
    p = sub.add_parser('payments', help='list payments')
    p.add_argument('--customer', default=CUSTOMER)
    p.add_argument('--order')
    p.add_argument('--status')

    args = parser.parse_args(argv)
    if not args.command:
        parser.print_help()
        return 1
    api = Api(args.order_url, args.payment_url)

    try:
        if args.command == 'demo':
            print('FoodExpress end-to-end test  (order: {}, payment: {})\n'.format(api.order_url, api.payment_url))
            result = run_demo(api)
            total = result.passed + result.failed
            print('\n{}/{} checks passed'.format(result.passed, total))
            return 0 if result.failed == 0 else 1
        if args.command == 'health':
            show('order-service health', *api.health_order())
            show('payment-service health', *api.health_payment())
        elif args.command == 'menu':
            show('menu', *api.menu())
        elif args.command == 'order':
            status, body = api.place_order(args.restaurant_id, args.items, args.method, args.card,
                                           args.customer, args.address)
            show('place order', status, body)
            if status == 201:
                print('Order id: {}  payment: {}  (next: advance {} / track {})'.format(
                    body['id'], body['payment']['paymentId'], body['id'], body['id']))
            return 0 if status == 201 else 1
        elif args.command == 'status':
            show('{} -> {}'.format(args.order_id, args.status), *api.set_status(args.order_id, args.status))
        elif args.command == 'advance':
            status, body = api.track(args.order_id)
            if status != 200:
                show('track ' + args.order_id, status, body)
                return 1
            if body['status'] not in LIFECYCLE[:-1]:
                print('Order {} is {}; nothing to advance.'.format(args.order_id, body['status']))
                return 0 if body['status'] == 'DELIVERED' else 1
            for next_status in LIFECYCLE[LIFECYCLE.index(body['status']) + 1:]:
                status, body = api.set_status(args.order_id, next_status)
                print('{} -> {}  HTTP {}'.format(args.order_id, next_status, status))
                if status != 200:
                    show('error', status, body)
                    return 1
            print('Order {} is now {} (payment {})'.format(args.order_id, body['status'], payment_status(body)))
        elif args.command == 'track':
            show('track ' + args.order_id, *api.track(args.order_id))
        elif args.command == 'cancel':
            show('cancel ' + args.order_id, *api.cancel(args.order_id, args.reason))
        elif args.command == 'retry-payment':
            show('retry payment ' + args.order_id, *api.retry_payment(args.order_id))
        elif args.command == 'history':
            show('order history of ' + args.customer, *api.history(args.customer))
        elif args.command == 'payment':
            show('payment ' + args.payment_id, *api.payment(args.payment_id))
        elif args.command == 'payments':
            show('payments', *api.payments(customerId=args.customer, orderId=args.order, status=args.status))
        return 0
    except urllib.error.URLError as err:
        print('Cannot reach the service: {}'.format(err.reason))
        print('Is the port-forward running? Check the URLs: order={} payment={}'.format(api.order_url, api.payment_url))
        return 2


if __name__ == '__main__':
    sys.exit(main())
