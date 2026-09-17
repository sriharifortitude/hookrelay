# hookrelay

[![CI](https://github.com/sriharifortitude/hookrelay/actions/workflows/ci.yml/badge.svg)](https://github.com/sriharifortitude/hookrelay/actions/workflows/ci.yml)

Outbound webhook delivery as a service. Your application publishes a message;
every subscribed endpoint receives a signed POST, retried on a published
schedule, dead-lettered when exhausted, replayable on demand. Self-hostable.

Source-available under the [Business Source License 1.1](LICENSE).

---

## The problem

Every product that integrates with anything ends up sending webhooks, and
the first implementation is always the same: `fetch(url, { body })` in a
request handler. Then a customer's endpoint goes down for an hour, and the
questions start. Did we retry? How many times? Can we resend the ones that
failed? How do they verify it was us? Why did we DDoS their staging server
when it came back?

Webhook delivery is a queue, a retry policy, a signature scheme, an audit
log and a circuit breaker. This is those, behind an API.

## What it does

```
POST /applications              admin: create an application, get its API key
POST /endpoints                 register a URL; get a signing secret
POST /messages                  publish; fans out to every subscribed endpoint
GET  /deliveries?status=failed  what went wrong
POST /deliveries/:id/replay     send it again
```

OpenAPI 3.1 at `/docs`, generated from the route schemas — [`openapi.json`](openapi.json)
is committed and never hand-edited.

- **Signatures follow [Standard Webhooks](https://www.standardwebhooks.com).**
  Not a home-grown scheme: a receiver with any existing Standard Webhooks
  verifier can validate deliveries without reading our docs. Secret rotation
  signs with both secrets for the overlap.
- **Retries on a fixed, quotable schedule** — 5s, 30s, 2m, 10m, 1h, 6h, 24h,
  with jitter — then dead-letter. 4xx (other than 408/429) is not retried:
  the receiver rejected the request itself and an identical retry will not
  change its mind.
- **Idempotent publishing** via `Idempotency-Key`. A repeated request returns
  the original message and publishes nothing.
- **Idempotent delivery** per attempt: if the same job runs twice, the second
  finds the attempt already recorded and exits. The customer never gets a
  duplicate POST from a queue hiccup.
- **Circuit breaker.** Ten consecutive failures disables the endpoint. A dead
  receiver stops accumulating a queue that will flood it on recovery.
- **Every attempt is recorded** — status, truncated body, error, duration —
  so "did you send it?" has an answer.
- **Endpoint URLs are screened** against private and link-local address
  space, https is required outside development, and redirects are never
  followed: a 3xx would send the signed body somewhere the customer did not
  register.

## Design

Fastify with TypeBox schemas, so validation, static types and the OpenAPI
document come from one definition. PostgreSQL via Prisma for state. BullMQ on
Redis for scheduling — but BullMQ's own retries are disabled; the delivery
engine owns the schedule and writes every attempt, and a second invisible
retry layer would make the attempt log a lie.

The delivery decision — success, retry with which delay, fail for which
reason, trip the breaker — is a pure function in `src/core/deliver.ts` over an
injected transport. The worker and the database sit around it. Everything
arguable is unit-tested with a fake transport; the integration suite then
runs the real thing against a receiver started in the test, which verifies
the signature with the same code a customer would.

## Running it

```bash
cp .env.example .env         # set ADMIN_API_KEY; instructions inside
npm ci
npm run db:up
npm run db:deploy
npm run dev                  # API on :4000, docs at /docs
npm run worker               # second terminal
```

Then:

```bash
curl -X POST localhost:4000/applications \
  -H "Authorization: Bearer $ADMIN_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"my-app"}'
# → { "apiKey": "hr_live_..." }

curl -X POST localhost:4000/endpoints \
  -H "Authorization: Bearer hr_live_..." -H "Content-Type: application/json" \
  -d '{"url":"https://your-receiver.example/hook","eventTypes":["order.created"]}'
# → { "secret": "whsec_..." }

curl -X POST localhost:4000/messages \
  -H "Authorization: Bearer hr_live_..." -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-42" \
  -d '{"eventType":"order.created","payload":{"orderId":42}}'
```

Verifying on the receiving side, in any language, is the Standard Webhooks
algorithm: HMAC-SHA256 of `${webhook-id}.${webhook-timestamp}.${body}` with
the base64-decoded secret, compared in constant time against the
`webhook-signature` header. `src/core/signing.ts` has a reference
implementation.

## Testing

```bash
npm test                 # 42 unit: signing against the spec test vector, backoff,
                         # retryability, the delivery decision, URL screening
npm run test:integration # 12 against real Postgres, Redis and HTTP: fan-out,
                         # idempotency, retry-then-succeed, dead-letter-then-replay,
                         # per-attempt idempotency, circuit breaker, tenant isolation
```

## Limitations

- **Secret retirement is manual.** Rotation adds a new secret and keeps the
  old one signing; nothing yet drops the old one after a window.
- **No rate limiting per endpoint.** A burst of messages is a burst of
  deliveries. Concurrency is capped at the worker, not per receiver.
- **No inbound webhooks.** This sends. Receiving, transforming and forwarding
  is a different product.
- **Single region, single queue.** Fine for tens of thousands of deliveries a
  day; sharding is not built.

## Licence

[Business Source License 1.1](LICENSE). Change date 2030-09-07, converts to
Apache 2.0. Licensor: Sri Hari Manikandan.
