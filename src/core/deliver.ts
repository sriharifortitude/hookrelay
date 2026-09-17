import { CIRCUIT_BREAKER_THRESHOLD, delayBeforeAttempt, isRetryable } from './backoff.js';
import { sign } from './signing.js';

/**
 * One delivery attempt and the decision that follows it, as a pure function
 * over an injected HTTP transport. The BullMQ processor and the database
 * writes sit around this; everything that can be argued about -- what
 * counts as success, when to retry, when to give up, when to trip the
 * breaker -- is here, and testable with a fake transport.
 */

export interface DeliveryTarget {
  readonly messageId: string;
  readonly url: string;
  readonly secrets: readonly string[];
  readonly eventType: string;
  readonly payload: unknown;
  readonly attemptNumber: number;
  readonly endpointConsecutiveFailures: number;
}

export interface HttpResult {
  readonly status?: number;
  readonly body?: string;
  readonly error?: string;
  readonly durationMs: number;
}

export type Transport = (request: {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}) => Promise<HttpResult>;

export type Outcome =
  | { readonly kind: 'succeeded'; readonly result: HttpResult }
  | { readonly kind: 'retry'; readonly result: HttpResult; readonly delayMs: number; readonly tripBreaker: boolean }
  | { readonly kind: 'failed'; readonly result: HttpResult; readonly reason: 'exhausted' | 'rejected'; readonly tripBreaker: boolean };

/** Bodies are stored for diagnosis, not archived. */
export const MAX_STORED_BODY = 1024;

export async function attemptDelivery(
  target: DeliveryTarget,
  transport: Transport,
  options: { readonly now?: Date; readonly random?: () => number } = {},
): Promise<Outcome> {
  const body = JSON.stringify({
    id: target.messageId,
    type: target.eventType,
    timestamp: (options.now ?? new Date()).toISOString(),
    data: target.payload,
  });

  const signed = sign(target.secrets, target.messageId, options.now ?? new Date(), body);

  const result = await transport({
    url: target.url,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'hookrelay/0.1',
      ...signed,
    },
    body,
  });

  const stored: HttpResult = {
    ...result,
    ...(result.body === undefined ? {} : { body: result.body.slice(0, MAX_STORED_BODY) }),
  };

  if (result.status !== undefined && result.status >= 200 && result.status < 300) {
    return { kind: 'succeeded', result: stored };
  }

  const failures = target.endpointConsecutiveFailures + 1;
  const tripBreaker = failures >= CIRCUIT_BREAKER_THRESHOLD;

  if (!isRetryable(result.status)) {
    return { kind: 'failed', result: stored, reason: 'rejected', tripBreaker };
  }

  const delayMs = delayBeforeAttempt(target.attemptNumber + 1, options.random);
  if (delayMs === undefined) {
    return { kind: 'failed', result: stored, reason: 'exhausted', tripBreaker };
  }
  return { kind: 'retry', result: stored, delayMs, tripBreaker };
}
