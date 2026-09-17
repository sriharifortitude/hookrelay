import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

import { env } from './env.js';

export const DELIVERY_QUEUE = 'deliveries';

export interface DeliveryJob {
  readonly deliveryId: string;
}

export const connection = new Redis(env.REDIS_URL, { maxRetriesPerRequest: null });

export const deliveryQueue = new Queue<DeliveryJob>(DELIVERY_QUEUE, {
  connection,
  defaultJobOptions: {
    // Retry scheduling is the delivery engine's job, with its own schedule
    // and its own record of every attempt. BullMQ's retries would be a
    // second, invisible layer on top of it.
    attempts: 1,
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 86_400 },
  },
});

/**
 * Job id is the delivery id plus the attempt number, so enqueueing the same
 * attempt twice -- a replayed request, a scheduler that ran twice -- is a
 * no-op rather than a duplicate POST to the customer's endpoint.
 */
export async function enqueueDelivery(deliveryId: string, attemptNumber: number, delayMs = 0): Promise<void> {
  await deliveryQueue.add('deliver', { deliveryId }, { jobId: `${deliveryId}-${attemptNumber}`, delay: delayMs });
}
