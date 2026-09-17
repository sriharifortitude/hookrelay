import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from './env.js';

export const DELIVERY_QUEUE = 'deliveries';

export interface DeliveryJob {
  readonly deliveryId: string;
}

/**
 * Created on first use rather than at import. Importing the API (to build
 * the OpenAPI document, to run a unit test) must not open a socket to Redis,
 * and a process that never enqueues anything should never need to close one.
 */
let connection: Redis | undefined;
let queue: Queue<DeliveryJob> | undefined;

export function redisConnection(): Redis {
  connection ??= new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });
  return connection;
}

export function deliveryQueue(): Queue<DeliveryJob> {
  queue ??= new Queue<DeliveryJob>(DELIVERY_QUEUE, {
    connection: redisConnection(),
    defaultJobOptions: {
      // Retry scheduling is the delivery engine's job, with its own schedule
      // and its own record of every attempt. BullMQ's retries would be a
      // second, invisible layer on top of it.
      attempts: 1,
      removeOnComplete: { age: 3600, count: 5000 },
      removeOnFail: { age: 86_400 },
    },
  });
  return queue;
}

/**
 * Job id is the delivery id plus the attempt number, so enqueueing the same
 * attempt twice -- a replayed request, a scheduler that ran twice -- is a
 * no-op rather than a duplicate POST to the customer's endpoint.
 */
export async function enqueueDelivery(deliveryId: string, attemptNumber: number, delayMs = 0): Promise<void> {
  await deliveryQueue().add('deliver', { deliveryId }, { jobId: `${deliveryId}-${attemptNumber}`, delay: delayMs });
}

export async function closeQueue(): Promise<void> {
  if (queue !== undefined) await queue.close();
  if (connection !== undefined) await connection.quit();
  queue = undefined;
  connection = undefined;
}
