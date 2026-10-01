import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import IORedis, { Redis } from 'ioredis';
import { env } from '../../config/env';

export const REDIS = Symbol('REDIS');
export const InjectRedis = () => Inject(REDIS);

export function createRedis(): Redis {
  return new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: true, lazyConnect: false });
}

@Global()
@Module({
  providers: [{ provide: REDIS, useFactory: createRedis }],
  exports: [REDIS],
})
export class RedisModule implements OnModuleDestroy {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}
  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }
}
