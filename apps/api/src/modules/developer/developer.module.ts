import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { CoursesModule } from '../courses/courses.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { ScenariosModule } from '../scenarios/scenarios.module';
import { WebhooksModule } from '../webhooks/webhooks.module';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { IdempotencyInterceptor } from './v1/idempotency.interceptor';
import { ApiKeyV1Guard } from './v1/v1.common';
import { V1AgentController } from './v1/v1-agent.controller';
import { V1OrgController } from './v1/v1-org.controller';
import { V1ScenariosController } from './v1/v1-scenarios.controller';
import { V1SessionsController } from './v1/v1-sessions.controller';
import { V1AccessTokensController, V1WebhooksController } from './v1/v1-tokens-webhooks.controller';

/**
 * Developer platform (workstream H): API keys and the versioned REST API under /api/v1
 * (API-key auth, scopes, idempotency keys, per-key rate limits). Business rules live in the owning
 * workstreams' services; v1 controllers only adapt them.
 */
@Module({
  imports: [ScenariosModule, RuntimeModule, AnalysisModule, CoursesModule, AccessModule, WebhooksModule],
  controllers: [
    ApiKeysController,
    V1ScenariosController,
    V1SessionsController,
    V1OrgController,
    V1AccessTokensController,
    V1WebhooksController,
    V1AgentController,
  ],
  providers: [ApiKeysService, IdempotencyInterceptor, ApiKeyV1Guard],
  exports: [ApiKeysService],
})
export class DeveloperModule {}
