import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { AuditModule } from './common/audit/audit.service';
import { AuthGuard } from './common/auth/auth.guard';
import { WorkspaceGuard } from './common/auth/workspace.guard';
import { CryptoModule } from './common/crypto/crypto.service';
import { DomainEventsModule } from './common/events/domain-events';
import { GlobalExceptionFilter } from './common/http/errors';
import { LlmModule } from './common/llm/llm.service';
import { MailModule } from './common/mail/mail.service';
import { PrismaModule } from './common/prisma/prisma.module';
import { QueueModule } from './common/queue/queue.service';
import { RateLimitModule } from './common/rate-limit/rate-limit.service';
import { RedisModule } from './common/redis/redis.module';
import { StorageModule } from './common/storage/storage.service';
import { AccessModule } from './modules/access/access.module';
import { AdminModule } from './modules/admin/admin.module';
import { AnalysisModule } from './modules/analysis/analysis.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AuthModule } from './modules/auth/auth.module';
import { ChannelsModule } from './modules/channels/channels.module';
import { CoachModule } from './modules/coach/coach.module';
import { CoursesModule } from './modules/courses/courses.module';
import { DeveloperModule } from './modules/developer/developer.module';
import { HealthModule } from './modules/health/health.module';
import { KnowledgeModule } from './modules/knowledge/knowledge.module';
import { MediaModule } from './modules/media/media.module';
import { ProvidersModule } from './modules/providers/providers.module';
import { RuntimeModule } from './modules/runtime/runtime.module';
import { ScenariosModule } from './modules/scenarios/scenarios.module';
import { UsageCoreModule } from './modules/usage/usage.service';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WorkspacesModule } from './modules/workspaces/workspaces.module';

@Module({
  imports: [
    // infrastructure (global)
    PrismaModule,
    RedisModule,
    CryptoModule,
    AuditModule,
    StorageModule,
    QueueModule,
    RateLimitModule,
    MailModule,
    LlmModule,
    DomainEventsModule,
    UsageCoreModule,
    // features
    HealthModule,
    AuthModule,
    WorkspacesModule,
    MediaModule,
    AdminModule,
    ScenariosModule,
    AccessModule,
    RuntimeModule,
    AnalysisModule,
    KnowledgeModule,
    CoachModule,
    CoursesModule,
    AnalyticsModule,
    ProvidersModule,
    WebhooksModule,
    DeveloperModule,
    ChannelsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: WorkspaceGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
  ],
})
export class AppModule {}
