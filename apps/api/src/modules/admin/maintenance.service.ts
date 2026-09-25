import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { QueueService, QUEUES, workerRuntime } from '../../common/queue/queue.service';
import { PrivacyService } from './privacy.service';
import { UsageAdminService } from './usage-admin.service';

export const ADMIN_JOBS = {
  checkAlerts: 'usage.checkAlerts',
  retention: 'privacy.retention',
  dataRequest: 'privacy.request',
} as const;

/**
 * Repeatable org-admin jobs on QUEUES.adminMaintenance:
 *  - usage.checkAlerts  hourly (quota thresholds → alerts → admin emails/notifications)
 *  - privacy.retention  daily at 03:17 UTC
 *  - privacy.request    one-off per DataRequest (jobId datareq_<id>)
 */
@Injectable()
export class AdminMaintenanceService implements OnModuleInit {
  private readonly logger = new Logger('AdminMaintenance');

  constructor(
    private readonly queue: QueueService,
    private readonly usage: UsageAdminService,
    private readonly privacy: PrivacyService,
  ) {}

  async onModuleInit() {
    if (!workerRuntime.enabled) return;
    this.queue.process(QUEUES.adminMaintenance, (job) => this.handle(job), 2);
    try {
      const q = this.queue.queue(QUEUES.adminMaintenance);
      // upsertJobScheduler is idempotent across restarts and multiple processes.
      await q.upsertJobScheduler('usage-check-alerts', { pattern: '7 * * * *' }, { name: ADMIN_JOBS.checkAlerts, data: {} });
      await q.upsertJobScheduler('privacy-retention', { pattern: '17 3 * * *' }, { name: ADMIN_JOBS.retention, data: {} });
    } catch (e: any) {
      this.logger.error(`Could not register maintenance schedules: ${e?.message}`);
    }
  }

  async handle(job: Job) {
    switch (job.name) {
      case ADMIN_JOBS.checkAlerts:
        return this.usage.checkAllWorkspaces();
      case ADMIN_JOBS.retention:
        return this.privacy.runRetention();
      case ADMIN_JOBS.dataRequest:
        return this.privacy.process(String((job.data as { requestId?: string })?.requestId ?? ''));
      default:
        throw new Error(`Unknown admin maintenance job: ${job.name}`);
    }
  }
}
