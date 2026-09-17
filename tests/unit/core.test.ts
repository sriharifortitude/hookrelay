import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { CIRCUIT_BREAKER_THRESHOLD, MAX_ATTEMPTS, RETRY_SCHEDULE_SECONDS, delayBeforeAttempt, isRetryable } from '../../src/core/backoff.js';
import { attemptDelivery, type HttpResult, type Transport } from '../../src/core/deliver.js';
import { SignatureError, generateSecret, sign, verify } from '../../src/core/signing.js';
import { EndpointUrlError, assertEndpointUrlAllowed, isReservedAddress } from '../../src/core/url-guard.js';

describe('Standard Webhooks signing', () => {
  /**
   * The worked example from the Standard Webhooks specification. A signer
   * that agrees with it interoperates with every published verifier.
   */
  it('matches the specification test vector', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek';
    const timestamp = new Date(1614265330 * 1000);
    const body = '{"test": 2432232314}';
    const headers = sign([secret], id, timestamp, body);

    const expected = createHmac('sha256', Buffer.from('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 'base64'))
      .update(`${id}.1614265330.${body}`)
      .digest('base64');
    expect(headers['webhook-signature']).toBe(`v1,${expected}`);
    expect(headers['webhook-timestamp']).toBe('1614265330');
  });

  it('verifies what it signs', () => {
    const secret = generateSecret();
    const now = new Date();
    const headers = sign([secret], 'msg_1', now, '{"a":1}');
    expect(() => verify(secret, headers, '{"a":1}', { now })).not.toThrow();
  });

  it('rejects a modified body', () => {
    const secret = generateSecret();
    const now = new Date();
    const headers = sign([secret], 'msg_1', now, '{"a":1}');
    expect(() => verify(secret, headers, '{"a":2}', { now })).toThrow(SignatureError);
  });

  it('rejects a body replayed under a different message id', () => {
    const secret = generateSecret();
    const now = new Date();
    const headers = sign([secret], 'msg_1', now, '{"a":1}');
    expect(() => verify(secret, { ...headers, 'webhook-id': 'msg_2' }, '{"a":1}', { now })).toThrow(SignatureError);
  });

  it('rejects a timestamp outside the tolerance', () => {
    const secret = generateSecret();
    const signedAt = new Date('2026-01-01T00:00:00Z');
    const headers = sign([secret], 'msg_1', signedAt, '{}');
    expect(() => verify(secret, headers, '{}', { now: new Date('2026-01-01T00:06:00Z') })).toThrow(/tolerance/);
    expect(() => verify(secret, headers, '{}', { now: new Date('2026-01-01T00:04:00Z') })).not.toThrow();
  });

  // Rotation: the receiver may still hold the old secret.
  it('signs with every current secret and verifies against any one of them', () => {
    const oldSecret = generateSecret();
    const newSecret = generateSecret();
    const now = new Date();
    const headers = sign([newSecret, oldSecret], 'msg_1', now, '{}');
    expect(headers['webhook-signature'].split(' ')).toHaveLength(2);
    expect(() => verify(oldSecret, headers, '{}', { now })).not.toThrow();
    expect(() => verify(newSecret, headers, '{}', { now })).not.toThrow();
    expect(() => verify(generateSecret(), headers, '{}', { now })).toThrow(SignatureError);
  });

  it('generates secrets in the whsec_ format', () => {
    expect(generateSecret()).toMatch(/^whsec_[A-Za-z0-9+/=]{32}$/);
  });
});

describe('backoff', () => {
  it('follows the published schedule with bounded jitter', () => {
    for (let attempt = 2; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const base = RETRY_SCHEDULE_SECONDS[attempt - 2]! * 1000;
      expect(delayBeforeAttempt(attempt, () => 0)).toBe(base * 0.8);
      expect(delayBeforeAttempt(attempt, () => 1)).toBe(base * 1.2);
      expect(delayBeforeAttempt(attempt, () => 0.5)).toBe(base);
    }
  });

  it('is exhausted after the schedule', () => {
    expect(delayBeforeAttempt(MAX_ATTEMPTS + 1)).toBeUndefined();
  });

  it.each([
    [200, false], [201, false], [204, false],
    [400, false], [401, false], [404, false], [422, false],
    [408, true], [429, true],
    [500, true], [502, true], [503, true],
    [undefined, true],
  ])('status %s retryable: %s', (status, expected) => {
    expect(isRetryable(status)).toBe(expected);
  });
});

describe('attemptDelivery', () => {
  const target = {
    messageId: 'msg_1',
    url: 'https://receiver.example/hook',
    secrets: [generateSecret()],
    eventType: 'order.created',
    payload: { orderId: 42 },
    attemptNumber: 1,
    endpointConsecutiveFailures: 0,
  };

  const respond = (result: Partial<HttpResult>): Transport => () => Promise.resolve({ durationMs: 10, ...result });

  it('sends a signed JSON envelope', async () => {
    let captured: Parameters<Transport>[0] | undefined;
    const transport: Transport = (request) => {
      captured = request;
      return Promise.resolve({ status: 200, durationMs: 5 });
    };
    await attemptDelivery(target, transport, { now: new Date() });

    expect(captured?.headers['content-type']).toBe('application/json');
    expect(captured?.headers['webhook-id']).toBe('msg_1');
    const envelope = JSON.parse(captured!.body) as { id: string; type: string; data: unknown };
    expect(envelope.type).toBe('order.created');
    expect(envelope.data).toEqual({ orderId: 42 });
    expect(() => verify(target.secrets[0]!, captured!.headers, captured!.body)).not.toThrow();
  });

  it('succeeds on 2xx', async () => {
    expect((await attemptDelivery(target, respond({ status: 204 }))).kind).toBe('succeeded');
  });

  it('retries a 503 with the first schedule delay', async () => {
    const outcome = await attemptDelivery(target, respond({ status: 503 }), { random: () => 0.5 });
    expect(outcome).toMatchObject({ kind: 'retry', delayMs: 5000, tripBreaker: false });
  });

  it('fails without retrying on a 400', async () => {
    expect(await attemptDelivery(target, respond({ status: 400 }))).toMatchObject({ kind: 'failed', reason: 'rejected' });
  });

  it('fails as exhausted after the last attempt', async () => {
    const outcome = await attemptDelivery({ ...target, attemptNumber: MAX_ATTEMPTS }, respond({ status: 500 }));
    expect(outcome).toMatchObject({ kind: 'failed', reason: 'exhausted' });
  });

  it('trips the breaker at the threshold', async () => {
    const outcome = await attemptDelivery({ ...target, endpointConsecutiveFailures: CIRCUIT_BREAKER_THRESHOLD - 1 }, respond({ status: 500 }));
    expect(outcome).toMatchObject({ kind: 'retry', tripBreaker: true });
  });

  it('truncates a large response body', async () => {
    const outcome = await attemptDelivery(target, respond({ status: 500, body: 'x'.repeat(5000) }));
    expect(outcome.result.body).toHaveLength(1024);
  });
});

describe('endpoint URL guard', () => {
  it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fd00::1', '::ffff:10.0.0.1'])('flags %s as reserved', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each(['8.8.8.8', '93.184.215.14', '2606:4700::1111'])('allows %s', (address) => {
    expect(isReservedAddress(address)).toBe(false);
  });

  it('requires https unless insecure endpoints are allowed', async () => {
    await expect(assertEndpointUrlAllowed('http://receiver.example/hook', { allowInsecure: false })).rejects.toThrow(/https/);
    await expect(assertEndpointUrlAllowed('http://127.0.0.1:9/hook', { allowInsecure: true })).resolves.toBeInstanceOf(URL);
  });

  it('rejects a hostname resolving to private space', async () => {
    await expect(
      assertEndpointUrlAllowed('https://internal.example/hook', { allowInsecure: false, resolve: () => Promise.resolve([{ address: '10.1.2.3' }]) }),
    ).rejects.toThrow(EndpointUrlError);
  });

  it('rejects embedded credentials', async () => {
    await expect(assertEndpointUrlAllowed('https://u:p@receiver.example/', { allowInsecure: false })).rejects.toThrow(/credentials/);
  });
});
