# notif-proto — e-commerce notification system prototype

Node.js ≥ 20, **no dependencies** (native `http` module, `node:test`).

```bash
npm start        # http://localhost:3000 (PORT configurable)
npm test         # 7 end-to-end tests over HTTP
```

## Routes

| Method | Route | Purpose |
|---|---|---|
| POST | `/events` | Publishes a business event → `202` (accepted), `200` (duplicate), `400` (invalid) |
| GET | `/users/:id/notifications` | History and status of each send (`pending`, `retrying`, `sent`, `skipped`, `dead`) |
| PUT | `/users/:id/preferences` | `{ "channels": { "sms": false }, "marketingOptIn": true }` |
| GET | `/health` | Queue status |

Event types: `order.placed`, `order.shipped`, `order.delivered`, `product.viewed`, `promotion.started`.

## Demo

Preloaded users: `u1` (all channels, marketing opt-in), `u2` (SMS disabled, no push, no opt-in), `u3` (failing email → retry then dead letter).

```bash
# Order shipped
curl -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"eventId":"e1","type":"order.shipped","payload":{"orderId":"C42","userId":"u1","carrier":"Colissimo"}}'

# Promotion on a viewed product: the view first, then the promo
curl -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"eventId":"v1","type":"product.viewed","payload":{"userId":"u1","productId":"P1"}}'
curl -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"eventId":"p1","type":"promotion.started","payload":{"productId":"P1","productName":"Headphones","discountPercent":20}}'

curl localhost:3000/users/u1/notifications
```

## Code layout

```
src/server.js     HTTP API
src/notifier.js   core: idempotent ingestion → planning (fan-out, preferences,
                  consent, throttling) → delivery (exponential retry, DLQ)
src/bus.js        in-memory queue (stands in for SQS / RabbitMQ / Kafka)
src/rules.js      event → channel routing + message templates
src/channels.js   email / SMS / push adapters (simulated)
src/store.js      in-memory storage + demo data
```
