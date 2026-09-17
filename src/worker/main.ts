import { Worker } from 'bullmq';

import { DELIVERY_QUEUE, connection, type DeliveryJob } from '../queue.js';
import { processDelivery } from './process.js';

const worker = new Worker<DeliveryJob>(DELIVERY_QUEUE, (job) => processDelivery(job.data.deliveryId), {
  connection,
  concurrency: 16,
});

worker.on('failed', (job, error) => process.stderr.write(`delivery job ${job?.id ?? '?'} failed: ${error.message}\n`));
process.stdout.write('delivery worker started\n');

const shutdown = async (): Promise<void> => {
  await worker.close();
  await connection.quit();
  process.exit(0);
};
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
