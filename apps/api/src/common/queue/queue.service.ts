import { Global, Injectable, Logger, Module, OnModuleDestroy } from '@nestjs/common';
import { Job, JobsOptions, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../../config/env';

export const QUEUES = {
  /** Post-session pipeline: finalize → score → extract → report → analytics → notify. */
  pipeline: 'session-pipeline',
  knowledge: 'knowledge-ingest',
  webhooks: 'webhook-delivery',
  notifications: 'notifications',
  channels: 'channels',
  maintenance: 'maintenance',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Set by worker.ts (or RUN_WORKERS_IN_API) to decide whether this process consumes jobs. */
export const workerRuntime = { enabled: false };

/**
 * Thin BullMQ wrapper. Producers call enqueue() with a deterministic jobId for idempotency
 * (BullMQ ignores a job whose id already exists). Consumers register with process().
 */
@Injectable()
export class QueueService implements OnModuleDestroy {
  private readonly logger = new Logger('Queue');
  private readonly connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];

  queue(name: QueueName): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, {
        connection: this.connection,
        defaultJobOptions: {
          attempts: 5,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
          removeOnFail: { age: 30 * 24 * 3600 },
        },
      });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue<T extends object>(queue: QueueName, jobName: string, data: T, opts: JobsOptions & { jobId?: string } = {}) {
    // BullMQ job ids may not contain ':'.
    const jobId = opts.jobId?.replace(/:/g, '_');
    return this.queue(queue).add(jobName, data, { ...opts, jobId });
  }

  process<T = any>(queue: QueueName, handler: (job: Job<T>) => Promise<unknown>, concurrency = 4) {
    if (!workerRuntime.enabled) return;
    const worker = new Worker<T>(queue, async (job) => handler(job), {
      connection: new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null }),
      concurrency,
    });
    worker.on('failed', (job, err) =>
      this.logger.warn(`Job ${queue}/${job?.name}#${job?.id} failed (attempt ${job?.attemptsMade}): ${err.message}`),
    );
    worker.on('error', (err) => this.logger.error(`Worker ${queue} error: ${err.message}`));
    this.workers.push(worker);
    this.logger.log(`Worker started for ${queue} (concurrency ${concurrency})`);
  }

  async onModuleDestroy() {
    await Promise.all(this.workers.map((w) => w.close().catch(() => undefined)));
    await Promise.all([...this.queues.values()].map((q) => q.close().catch(() => undefined)));
    await this.connection.quit().catch(() => undefined);
  }
}

@Global()
@Module({ providers: [QueueService], exports: [QueueService] })
export class QueueModule {}
