/**
 * Retry schedule for a failed delivery.
 *
 * Fixed steps rather than a formula, because the steps are a product
 * decision that support staff quote to customers: "we retry at roughly 5s,
 * 30s, 2m, 10m, 1h, 6h, and 24h". A formula gives the same numbers with less
 * legibility. Jitter is applied on top so a receiver that went down does not
 * get every queued delivery back in the same second when it recovers.
 */
export const RETRY_SCHEDULE_SECONDS: readonly number[] = [5, 30, 120, 600, 3_600, 21_600, 86_400];

/** The initial attempt plus one per schedule step. */
export const MAX_ATTEMPTS = RETRY_SCHEDULE_SECONDS.length + 1;

const JITTER_FRACTION = 0.2;

/**
 * Delay before attempt `nextAttemptNumber` (2 for the first retry), or
 * undefined when attempts are exhausted and the delivery should be
 * dead-lettered.
 */
export function delayBeforeAttempt(nextAttemptNumber: number, random: () => number = Math.random): number | undefined {
  const step = RETRY_SCHEDULE_SECONDS[nextAttemptNumber - 2];
  if (step === undefined) return undefined;
  const jitter = 1 + (random() * 2 - 1) * JITTER_FRACTION;
  return Math.round(step * jitter * 1000);
}

/**
 * Whether a response should be retried. 2xx is success. 4xx other than 408
 * and 429 is the receiver rejecting the request itself -- retrying an
 * identical request will not change a 400 or a 404. 5xx, 408, 429, timeouts
 * and connection errors are transient.
 */
export function isRetryable(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status >= 200 && status < 300) return false;
  if (status === 408 || status === 429) return true;
  if (status >= 400 && status < 500) return false;
  return true;
}

/**
 * Consecutive failures after which an endpoint is disabled. The number is
 * the schedule length: an endpoint that has failed through a full retry
 * cycle on one message and then fails the next one too is not coming back
 * on its own, and continuing to send is load on a dead receiver plus a
 * queue that never drains.
 */
export const CIRCUIT_BREAKER_THRESHOLD = 10;
