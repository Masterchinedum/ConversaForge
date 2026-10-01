import { Global, Injectable, Module } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { InjectRedis } from '../redis/redis.module';
import { Errors } from '../http/errors';

/** Fixed-window rate limiter on Redis. Keys should include the dimension, e.g. `run:ip:1.2.3.4`. */
@Injectable()
export class RateLimitService {
  constructor(@InjectRedis() private readonly redis: Redis) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
    const k = `rl:${key}:${bucket}`;
    const count = await this.redis.incr(k);
    if (count === 1) await this.redis.expire(k, windowSeconds + 1);
    const resetIn = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetIn };
  }

  async enforce(key: string, limit: number, windowSeconds: number, message?: string) {
    const r = await this.hit(key, limit, windowSeconds);
    if (!r.allowed) throw Errors.tooMany(message ?? 'Too many requests, please try again later', { retryAfterSeconds: r.resetIn });
    return r;
  }
}

@Global()
@Module({ providers: [RateLimitService], exports: [RateLimitService] })
export class RateLimitModule {}
