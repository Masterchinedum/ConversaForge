import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import { randomUUID } from 'node:crypto';
import { loadEnv } from './config/env';
import { workerRuntime } from './common/queue/queue.service';

async function bootstrap() {
  const env = loadEnv();
  workerRuntime.enabled = env.RUN_WORKERS_IN_API;
  // Import after env validation so modules can read config at construction time.
  const { AppModule } = await import('./app.module');

  const adapter = new FastifyAdapter({
    // Only trust X-Forwarded-For from our own proxies (Caddy/Next on private networks), so clients
    // cannot spoof their IP to evade rate limits. Override with TRUST_PROXY (proxy-addr syntax).
    trustProxy: env.TRUST_PROXY,
    bodyLimit: 12 * 1024 * 1024,
    // Signed media/download tokens travel as a path param (/api/media/signed/<token>); Fastify's default
    // maxParamLength (100) would reject them with 414.
    maxParamLength: 2048,
    genReqId: (req: { headers: Record<string, string | string[] | undefined> }) => (req.headers['x-request-id'] as string) || randomUUID(),
    logger: false,
  });
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    rawBody: true,
    logger: env.LOG_LEVEL === 'debug' ? ['log', 'error', 'warn', 'debug', 'verbose'] : ['log', 'error', 'warn'],
  });

  await app.register(cookie as any);
  await app.register(helmet as any, {
    contentSecurityPolicy: false, // API only returns JSON/media; the web app sets its own CSP
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  });
  await app.register(multipart as any, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });

  const origins = new Set([env.WEB_PUBLIC_URL, ...env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)]);
  app.enableCors({
    origin: (origin, cb) => {
      // Public/embed endpoints are called cross-origin with bearer tokens, never cookies.
      if (!origin || origins.has(origin)) return cb(null, true);
      cb(null, false);
    },
    credentials: true,
    exposedHeaders: ['X-Request-Id', 'Idempotency-Replayed'],
  });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();

  const doc = new DocumentBuilder()
    .setTitle('ConversaForge API')
    .setDescription('REST API for scenarios, sessions, analysis, courses, organizations and usage. See /docs/api.md.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', description: 'API key (cf_live_…)' })
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'api/openapi.json' });

  await app.listen(env.PORT, '0.0.0.0');
  Logger.log(`API listening on :${env.PORT} (workers in-process: ${workerRuntime.enabled})`, 'Bootstrap');
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
