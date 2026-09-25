import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { loadEnv } from './config/env';
import { workerRuntime } from './common/queue/queue.service';

/** Standalone job worker: `node dist/worker.js`. Registers every queue processor, no HTTP server. */
async function bootstrap() {
  loadEnv();
  workerRuntime.enabled = true;
  const { AppModule } = await import('./app.module');
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'error', 'warn'] });
  app.enableShutdownHooks();
  Logger.log('Worker started', 'Worker');
}

bootstrap().catch((e) => {
  // eslint-disable-next-line no-console
  console.error(e);
  process.exit(1);
});
