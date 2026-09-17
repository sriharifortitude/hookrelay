import { request as undiciRequest } from 'undici';

import { attemptDelivery, type HttpResult, type Transport } from '../core/deliver.js';
import { db } from '../db.js';
import { enqueueDelivery } from '../queue.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * The real transport. Redirects are not followed: a 3xx from the receiver is
 * a failure, because following one would send the signed body to a URL the
 * customer did not register -- which is the SSRF guard's whole purpose.
 */
export const httpTransport: Transport = async ({ url, headers, body }) => {
  const started = Date.now();
  try {
    const response = await undiciRequest(url, {
      method: 'POST',
      headers,
      body,
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS,
      maxRedirections: 0,
    });
    const text = await response.body.text().catch(() => '');
    return { status: response.statusCode, body: text, durationMs: Date.now() - started };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), durationMs: Date.now() - started };
  }
};

/**
 * Processes one delivery attempt end to end. Idempotent per attempt number:
 * if the same job runs twice, the second finds the attempt row already
 * written and exits. Injected transport for tests.
 */
export async function processDelivery(deliveryId: string, transport: Transport = httpTransport, now: Date = new Date()): Promise<void> {
  const delivery = await db.delivery.findUnique({
    where: { id: deliveryId },
    include: { message: true, endpoint: true },
  });
  if (delivery === null || delivery.status !== 'pending') return;
  if (!delivery.endpoint.enabled) {
    await db.delivery.update({ where: { id: deliveryId }, data: { status: 'failed', nextAttemptAt: null } });
    return;
  }

  const attemptNumber = delivery.attemptCount + 1;
  const existing = await db.attempt.findUnique({ where: { deliveryId_number: { deliveryId, number: attemptNumber } } });
  if (existing !== null) return;

  const outcome = await attemptDelivery(
    {
      messageId: delivery.messageId,
      url: delivery.endpoint.url,
      secrets: delivery.endpoint.secrets,
      eventType: delivery.message.eventType,
      payload: delivery.message.payload,
      attemptNumber,
      endpointConsecutiveFailures: delivery.endpoint.consecutiveFailures,
    },
    transport,
    { now },
  );

  await db.$transaction(async (tx) => {
    await tx.attempt.create({ data: { deliveryId, number: attemptNumber, ...attemptRow(outcome.result) } });

    if (outcome.kind === 'succeeded') {
      await tx.delivery.update({ where: { id: deliveryId }, data: { status: 'succeeded', attemptCount: attemptNumber, nextAttemptAt: null } });
      await tx.endpoint.update({ where: { id: delivery.endpointId }, data: { consecutiveFailures: 0 } });
      return;
    }

    const endpointData = outcome.tripBreaker
      ? { consecutiveFailures: { increment: 1 }, enabled: false, disabledReason: `Disabled after ${delivery.endpoint.consecutiveFailures + 1} consecutive failed deliveries.` }
      : { consecutiveFailures: { increment: 1 } };
    await tx.endpoint.update({ where: { id: delivery.endpointId }, data: endpointData });

    if (outcome.kind === 'retry') {
      await tx.delivery.update({ where: { id: deliveryId }, data: { attemptCount: attemptNumber, nextAttemptAt: new Date(now.getTime() + outcome.delayMs) } });
    } else {
      await tx.delivery.update({ where: { id: deliveryId }, data: { status: 'failed', attemptCount: attemptNumber, nextAttemptAt: null } });
    }
  });

  if (outcome.kind === 'retry' && !outcome.tripBreaker) {
    await enqueueDelivery(deliveryId, attemptNumber + 1, outcome.delayMs);
  }
}

function attemptRow(result: HttpResult): { responseStatus: number | null; responseBody: string | null; error: string | null; durationMs: number } {
  return {
    responseStatus: result.status ?? null,
    responseBody: result.body ?? null,
    error: result.error ?? null,
    durationMs: result.durationMs,
  };
}
