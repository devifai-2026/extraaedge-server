import { Queue, Worker, QueueEvents } from 'bullmq';
import { env } from '../config/env.js';
import { getRedis, redisAvailable } from './redis.js';
import { logger } from './logger.js';

// Unified queue API with BullMQ (prod) + in-process fallback (dev).
// All publishers call publish(queueName, jobName, data, opts).
// All consumers register via registerWorker(queueName, handler, concurrency).

const inProcessHandlers = new Map(); // queueName -> [{ jobName, handler }]
const bullQueues = new Map();

const useBull = () => env.QUEUE_DRIVER === 'bullmq' && redisAvailable();

// Whether jobs will actually travel through BullMQ, as opposed to the
// in-process fallback. Exported because index.js has to decide whether to load
// the worker modules into the web process, and deriving that rule a second
// time there is what created the hole this comment exists to prevent:
// QUEUE_DRIVER defaults to 'bullmq', so a deployment with no REDIS_URL fell
// through to the in-process branch of publish() while index.js — which only
// checked the driver string — never registered a single handler. Every job
// published on that box was dropped on the floor, silently, with a 202 to the
// caller. Ask the queue layer instead of re-deriving.
export const usingBull = () => useBull();

const getBullQueue = (queueName) => {
  if (!bullQueues.has(queueName)) {
    const q = new Queue(queueName, { connection: getRedis() });
    bullQueues.set(queueName, q);
  }
  return bullQueues.get(queueName);
};

export const publish = async (queueName, jobName, data, opts = {}) => {
  if (useBull()) {
    const q = getBullQueue(queueName);
    return q.add(jobName, data, {
      attempts: opts.attempts ?? 5,
      backoff: opts.backoff ?? { type: 'exponential', delay: 30_000 },
      removeOnComplete: opts.removeOnComplete ?? { age: 86_400, count: 1000 },
      removeOnFail: opts.removeOnFail ?? { age: 7 * 86_400 },
      delay: opts.delay,
      jobId: opts.jobId,
    });
  }
  const handlers = inProcessHandlers.get(queueName) ?? [];
  // A queue nobody listens to is not a no-op, it's data loss: the caller has
  // already written its own row (a bulk_import_previews row, a queued
  // bulk_imports row) and returned 202, so the job vanishing leaves the UI
  // polling a record that will never be updated. That is indistinguishable
  // from "the file had zero rows". Say so loudly instead.
  if (!handlers.some((h) => h.jobName === jobName || h.jobName === '*')) {
    logger.error(
      { queueName, jobName, driver: env.QUEUE_DRIVER, redis: redisAvailable() },
      'queue has no consumer — job dropped. Load the worker for this queue in-process, or set QUEUE_DRIVER/REDIS_URL so BullMQ is used.',
    );
    return { id: `dropped-${queueName}`, dropped: true };
  }
  // fire-and-forget in dev; errors logged but do not propagate
  setImmediate(async () => {
    for (const h of handlers) {
      if (h.jobName === jobName || h.jobName === '*') {
        try {
          await h.handler({ name: jobName, data });
        } catch (err) {
          logger.error({ err: err.message, queueName, jobName }, 'in-process queue handler failed');
        }
      }
    }
  });
  return { id: `inprocess-${Date.now()}` };
};

export const registerWorker = (queueName, handler, { concurrency = 4, jobName = '*' } = {}) => {
  if (useBull()) {
    const worker = new Worker(
      queueName,
      async (job) => handler({ name: job.name, data: job.data, id: job.id }),
      { connection: getRedis(), concurrency },
    );
    worker.on('failed', (job, err) => {
      logger.error({ queueName, jobId: job?.id, err: err.message }, 'worker job failed');
    });
    const events = new QueueEvents(queueName, { connection: getRedis() });
    events.on('completed', ({ jobId }) => logger.debug({ queueName, jobId }, 'job completed'));
    return worker;
  }
  // in-process: just register
  const list = inProcessHandlers.get(queueName) ?? [];
  list.push({ jobName, handler });
  inProcessHandlers.set(queueName, list);
  return { close: async () => {} };
};

export const closeQueues = async () => {
  await Promise.all([...bullQueues.values()].map((q) => q.close()));
  bullQueues.clear();
};
