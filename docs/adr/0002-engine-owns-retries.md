# 0002. The delivery engine owns retries; BullMQ's are disabled

**Status:** accepted

## Decision

Jobs are added with `attempts: 1`. When a delivery fails retryably, the
processor records the attempt, computes the next delay from the published
schedule, and enqueues a new job with that delay and a job id of
`{deliveryId}-{attemptNumber}`.

## Reasoning

BullMQ can retry with backoff on its own. Using it would mean two retry
layers -- the queue's and ours -- and an attempt log that does not match
what actually hit the customer's endpoint. Support staff quote the schedule
to customers; it has to be the only schedule.

The job id encoding the attempt number is what makes a duplicate enqueue a
no-op: a replayed API request or a scheduler that ran twice cannot produce
a second POST for the same attempt, and the processor additionally refuses
to run an attempt whose row already exists.

## Costs

A delayed job per retry rather than one job with a retry counter. BullMQ's
delayed set handles this at the scale in question without difficulty.
