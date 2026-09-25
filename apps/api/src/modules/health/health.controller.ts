import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import { Public } from '../../common/auth/decorators';
import { PrismaService } from '../../common/prisma/prisma.service';
import { REDIS } from '../../common/redis/redis.module';

@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness + dependency readiness. Used by load balancers and uptime monitors. */
  @Public()
  @Get('health')
  async health() {
    const started = Date.now();
    const [db, cache] = await Promise.allSettled([this.prisma.$queryRaw`SELECT 1`, this.redis.ping()]);
    const ok = db.status === 'fulfilled' && cache.status === 'fulfilled';
    return {
      status: ok ? 'ok' : 'degraded',
      db: db.status === 'fulfilled' ? 'ok' : 'down',
      redis: cache.status === 'fulfilled' ? 'ok' : 'down',
      latencyMs: Date.now() - started,
      version: process.env.APP_VERSION ?? 'dev',
    };
  }
}
