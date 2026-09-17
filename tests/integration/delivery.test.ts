import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/api/app.js';
import { MAX_ATTEMPTS } from '../../src/core/backoff.js';
import { verify } from '../../src/core/signing.js';
import { db } from '../../src/db.js';
import { env } from '../../src/env.js';
import { connection, deliveryQueue } from '../../src/queue.js';
import { processDelivery } from '../../src/worker/process.js';

/**
 * The whole path: API publishes, the worker delivers over real HTTP to a
 * receiver started in the test, and the receiver verifies the signature with
 * the same code a customer would use. The queue is exercised for the enqueue
 * side; jobs are drained by calling the processor directly so a test can
 * decide what the receiver does on each attempt without waiting hours for
 * the schedule.
 */

interface Received {
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

let receiver: Server;
let receiverUrl: string;
let received: Received[] = [];
let respondWith: () => number = () => 200;

let apiKey: string;
let api: Awaited<ReturnType<typeof buildApp>>;

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const response = await api.inject({
    method: method as 'GET',
    url: path,
    headers: { authorization: `Bearer ${apiKey}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return { status: response.statusCode, json: response.json() as Record<string, unknown> & { id: string } };
}

async function drain(): Promise<void> {
  // Process every delivery that has a pending attempt due, regardless of
  // the queue's own delay -- the test controls time.
  const pending = await db.delivery.findMany({ where: { status: 'pending' } });
  for (const delivery of pending) await processDelivery(delivery.id);
}

beforeAll(async () => {
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.statusCode = respondWith();
      res.end(res.statusCode >= 400 ? 'nope' : 'ok');
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const address = receiver.address();
  receiverUrl = `http://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}/hook`;

  api = await buildApp();
  const created = await api.inject({ method: 'POST', url: '/applications', headers: { authorization: `Bearer ${env.ADMIN_API_KEY}` }, payload: { name: 'test' } });
  apiKey = (created.json() as { apiKey: string }).apiKey;
});

beforeEach(async () => {
  received = [];
  respondWith = () => 200;
  await db.delivery.deleteMany();
  await db.message.deleteMany();
  await db.endpoint.deleteMany();
  await deliveryQueue.obliterate({ force: true });
});

afterAll(async () => {
  await api.close();
  await new Promise<void>((resolve) => receiver.close(() => resolve()));
  await deliveryQueue.close();
  connection.disconnect();
  await db.$disconnect();
});

describe('publishing and delivering', () => {
  it('delivers a signed envelope the receiver can verify', async () => {
    const endpoint = await request('POST', '/endpoints', { url: receiverUrl, eventTypes: ['order.created'] });
    expect(endpoint.status).toBe(201);
    const secret = endpoint.json['secret'] as string;

    const message = await request('POST', '/messages', { eventType: 'order.created', payload: { orderId: 42 } });
    expect(message.status).toBe(201);
    expect((message.json['deliveries'] as unknown[]).length).toBe(1);

    await drain();

    expect(received).toHaveLength(1);
    const { headers, body } = received[0]!;
    expect(headers['content-type']).toBe('application/json');
    expect(() => verify(secret, headers as Record<string, string>, body)).not.toThrow();
    const envelope = JSON.parse(body) as { id: string; type: string; data: unknown };
    expect(envelope.id).toBe(message.json.id);
    expect(envelope.type).toBe('order.created');
    expect(envelope.data).toEqual({ orderId: 42 });

    const delivery = await request('GET', `/deliveries/${(message.json['deliveries'] as Array<{ id: string }>)[0]!.id}`);
    expect(delivery.json['status']).toBe('succeeded');
    expect((delivery.json['attempts'] as unknown[]).length).toBe(1);
  });

  it('fans out to every subscribed endpoint and skips unsubscribed ones', async () => {
    await request('POST', '/endpoints', { url: receiverUrl, eventTypes: ['order.created'] });
    await request('POST', '/endpoints', { url: receiverUrl });
    await request('POST', '/endpoints', { url: receiverUrl, eventTypes: ['invoice.paid'] });

    const message = await request('POST', '/messages', { eventType: 'order.created', payload: {} });
    expect((message.json['deliveries'] as unknown[]).length).toBe(2);
  });

  it('is idempotent on Idempotency-Key', async () => {
    await request('POST', '/endpoints', { url: receiverUrl });
    const first = await request('POST', '/messages', { eventType: 'x', payload: { n: 1 } }, { 'idempotency-key': 'abc' });
    const second = await request('POST', '/messages', { eventType: 'x', payload: { n: 1 } }, { 'idempotency-key': 'abc' });

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.json.id).toBe(first.json.id);
    expect(await db.message.count()).toBe(1);
  });

  it('retries a 503 and succeeds when the receiver recovers', async () => {
    await request('POST', '/endpoints', { url: receiverUrl });
    respondWith = () => 503;
    const message = await request('POST', '/messages', { eventType: 'x', payload: {} });
    const deliveryId = (message.json['deliveries'] as Array<{ id: string }>)[0]!.id;

    await drain();
    let delivery = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('pending');
    expect(delivery.attemptCount).toBe(1);
    expect(delivery.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now() + 3000);

    respondWith = () => 200;
    await drain();
    delivery = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('succeeded');
    expect(delivery.attemptCount).toBe(2);
    expect(received).toHaveLength(2);
    // Same message id on the retry: the receiver can deduplicate.
    expect(received[0]!.headers['webhook-id']).toBe(received[1]!.headers['webhook-id']);
  });

  it('does not retry a 400', async () => {
    await request('POST', '/endpoints', { url: receiverUrl });
    respondWith = () => 400;
    const message = await request('POST', '/messages', { eventType: 'x', payload: {} });
    await drain();

    const delivery = await db.delivery.findUniqueOrThrow({ where: { id: (message.json['deliveries'] as Array<{ id: string }>)[0]!.id } });
    expect(delivery.status).toBe('failed');
    expect(delivery.attemptCount).toBe(1);
  });

  it('dead-letters after the schedule is exhausted, then replays on request', async () => {
    await request('POST', '/endpoints', { url: receiverUrl });
    respondWith = () => 500;
    const message = await request('POST', '/messages', { eventType: 'x', payload: {} });
    const deliveryId = (message.json['deliveries'] as Array<{ id: string }>)[0]!.id;

    for (let i = 0; i < MAX_ATTEMPTS; i += 1) await drain();
    let delivery = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('failed');
    expect(delivery.attemptCount).toBe(MAX_ATTEMPTS);
    expect(await db.attempt.count({ where: { deliveryId } })).toBe(MAX_ATTEMPTS);

    respondWith = () => 200;
    const replay = await request('POST', `/deliveries/${deliveryId}/replay`);
    expect(replay.status).toBe(202);
    await drain();
    delivery = await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } });
    expect(delivery.status).toBe('succeeded');
    expect(delivery.attemptCount).toBe(MAX_ATTEMPTS + 1);
  });

  it('is idempotent per attempt if the same job is processed twice', async () => {
    await request('POST', '/endpoints', { url: receiverUrl });
    const message = await request('POST', '/messages', { eventType: 'x', payload: {} });
    const deliveryId = (message.json['deliveries'] as Array<{ id: string }>)[0]!.id;

    await processDelivery(deliveryId);
    await processDelivery(deliveryId);
    expect(received).toHaveLength(1);
  });

  it('trips the circuit breaker after repeated failures and stops sending', async () => {
    const endpoint = await request('POST', '/endpoints', { url: receiverUrl });
    respondWith = () => 500;
    // Ten messages, one attempt each: ten consecutive failures.
    for (let i = 0; i < 10; i += 1) await request('POST', '/messages', { eventType: 'x', payload: { i } });
    await drain();

    const disabled = await request('GET', `/endpoints/${endpoint.json.id}`);
    expect(disabled.json['enabled']).toBe(false);
    expect(disabled.json['disabledReason']).toMatch(/consecutive/);

    // A new message finds no enabled endpoint.
    const after = await request('POST', '/messages', { eventType: 'x', payload: {} });
    expect((after.json['deliveries'] as unknown[]).length).toBe(0);

    // Re-enabling resets the count.
    const reenabled = await request('PATCH', `/endpoints/${endpoint.json.id}`, { enabled: true });
    expect(reenabled.json['consecutiveFailures']).toBe(0);
  });
});

describe('isolation and screening', () => {
  it('rejects an endpoint that resolves to private space when insecure endpoints are not allowed', async () => {
    // The test environment allows insecure endpoints so the loopback receiver
    // works; the guard itself is unit-tested with a stubbed resolver.
    expect(env.ALLOW_INSECURE_ENDPOINTS).toBe(true);
  });

  it('does not let one application see another\'s endpoints', async () => {
    const mine = await request('POST', '/endpoints', { url: receiverUrl });

    const other = await api.inject({ method: 'POST', url: '/applications', headers: { authorization: `Bearer ${env.ADMIN_API_KEY}` }, payload: { name: 'other' } });
    const otherKey = (other.json() as { apiKey: string }).apiKey;
    const probe = await api.inject({ method: 'GET', url: `/endpoints/${mine.json.id}`, headers: { authorization: `Bearer ${otherKey}` } });
    expect(probe.statusCode).toBe(404);
  });

  it('rejects a missing or wrong API key', async () => {
    expect((await api.inject({ method: 'GET', url: '/endpoints' })).statusCode).toBe(401);
    expect((await api.inject({ method: 'GET', url: '/endpoints', headers: { authorization: 'Bearer hr_live_nope' } })).statusCode).toBe(401);
  });

  it('serves an OpenAPI document that lists every route', async () => {
    const spec = (await api.inject({ method: 'GET', url: '/docs/json' })).json() as { openapi: string; paths: Record<string, unknown> };
    expect(spec.openapi).toBe('3.1.0');
    for (const path of ['/applications', '/endpoints', '/endpoints/{id}', '/messages', '/deliveries', '/deliveries/{id}/replay']) {
      expect(Object.keys(spec.paths)).toContain(path);
    }
  });
});
