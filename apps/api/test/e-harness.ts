/**
 * Workstream E integration-test harness: boots the real AppModule on Fastify (no listen) against the
 * dedicated Postgres database `conversaforge_test_e` and Redis db 5, and exposes helpers to create
 * users/workspaces/scenarios and make authenticated requests with app.inject().
 *
 * Setup once:  su postgres -c "createdb conversaforge_test_e"
 *              DATABASE_URL=postgresql://postgres:postgres@localhost:5432/conversaforge_test_e npx prisma db push --skip-generate
 */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import * as path from 'node:path';

export const TEST_DB = process.env.E_TEST_DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/conversaforge_test_e';
process.env.DATABASE_URL = TEST_DB;
process.env.REDIS_URL = process.env.E_TEST_REDIS_URL ?? 'redis://localhost:6379/5';
process.env.NODE_ENV = 'test';
process.env.WEB_PUBLIC_URL = 'http://localhost:3105';
process.env.API_PUBLIC_URL = 'http://localhost:4105';
process.env.STORAGE_DRIVER = 'local';
process.env.STORAGE_LOCAL_DIR = path.join(os.tmpdir(), `cf-e-test-storage-${process.pid}`);
process.env.RUN_WORKERS_IN_API = 'false';
process.env.ALLOW_SIMULATOR = 'true';
process.env.PUBLIC_RUN_RATE_LIMIT_PER_HOUR = '20';
process.env.ENCRYPTION_KEY ??= randomBytes(32).toString('hex');
process.env.SIGNING_SECRET ??= randomBytes(32).toString('hex');

import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import multipart from '@fastify/multipart';
import { defaultScenarioConfig, type ScenarioConfigInput } from '@cf/shared';
import type { Role } from '@prisma/client';

export type Injected = { statusCode: number; json: () => any; body: string; headers: Record<string, any> };

export class Harness {
  app!: NestFastifyApplication;
  prisma!: import('../src/common/prisma/prisma.service').PrismaService;
  crypto!: import('../src/common/crypto/crypto.service').CryptoService;
  mails: Array<{ to: string; subject: string; text: string }> = [];
  private ipSeq = 0;

  async start() {
    const { loadEnv } = await import('../src/config/env');
    loadEnv();
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    this.app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter({ trustProxy: true, maxParamLength: 2048 }), { logger: ['error'] });
    // @fastify/cookie is not registered: it lazy-loads `cookie` via dynamic import, which jest's VM
    // cannot run. Tests authenticate with bearer session tokens instead (AuthGuard accepts both).
    await this.app.register(multipart as any, { limits: { fileSize: 200 * 1024 * 1024, files: 1 } });
    this.app.setGlobalPrefix('api', { exclude: ['health'] });
    const { WsAdapter } = await import('@nestjs/platform-ws');
    this.app.useWebSocketAdapter(new WsAdapter(this.app));
    await this.app.init();
    await this.app.getHttpAdapter().getInstance().ready();
    const { PrismaService } = await import('../src/common/prisma/prisma.service');
    const { CryptoService } = await import('../src/common/crypto/crypto.service');
    const { MailService } = await import('../src/common/mail/mail.service');
    this.prisma = this.app.get(PrismaService);
    this.crypto = this.app.get(CryptoService);
    const mail = this.app.get(MailService);
    (mail as any).send = async (m: { to: string; subject: string; text: string }) => {
      this.mails.push(m);
      return { delivered: false, logged: true };
    };
    return this;
  }

  async stop() {
    await this.app?.close();
  }

  get<T>(cls: new (...a: any[]) => T): T {
    return this.app.get(cls as any) as T;
  }

  /** A unique client IP per call so rate limits of one test don't leak into another. */
  ip() {
    this.ipSeq++;
    return `10.${(process.pid >> 8) & 255}.${Math.floor(this.ipSeq / 250) % 250}.${(this.ipSeq % 250) + 1}`;
  }

  async req(method: string, url: string, opts: { token?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}): Promise<Injected> {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    const res = await this.app.inject({
      method: method as any,
      url,
      headers,
      payload: opts.body as any,
      remoteAddress: opts.ip ?? '127.0.0.1',
    });
    return { statusCode: res.statusCode, json: () => res.json(), body: res.body, headers: res.headers as any };
  }

  uid() {
    return randomBytes(5).toString('hex');
  }

  async user(name = 'User', email?: string) {
    const e = (email ?? `${name.toLowerCase().replace(/\W/g, '')}-${this.uid()}@test.example`).toLowerCase();
    const user = await this.prisma.user.create({ data: { email: e, name } });
    const token = this.crypto.randomToken(32);
    await this.prisma.authSession.create({ data: { userId: user.id, tokenHash: this.crypto.sha256(token), expiresAt: new Date(Date.now() + 86400_000) } });
    return { ...user, token };
  }

  async workspace(owner: { id: string }, kind: 'ORGANIZATION' | 'PERSONAL' = 'ORGANIZATION') {
    return this.prisma.workspace.create({
      data: { name: `WS ${this.uid()}`, slug: `ws-${this.uid()}`, kind, memberships: { create: { userId: owner.id, role: 'OWNER' } } },
    });
  }

  async member(workspaceId: string, role: Role, name = role.toLowerCase()) {
    const u = await this.user(name);
    const m = await this.prisma.membership.create({ data: { workspaceId, userId: u.id, role } });
    return { ...u, membershipId: m.id };
  }

  /** A published scenario (simulator LLM) with a small variable allowlist. */
  async scenario(workspaceId: string, over: ScenarioConfigInput = {}, privacy: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC' = 'PRIVATE') {
    const config = defaultScenarioConfig({
      ...over,
      basics: { name: 'Practice interview', publicDescription: 'A short practice interview', participantInstructions: 'Find a quiet room.', ...(over.basics ?? {}) },
      persona: { name: 'Alex', ...(over.persona ?? {}) },
      model: { llmProvider: 'simulator', ...(over.model ?? {}) },
      variables: over.variables ?? {
        allowlist: [
          { key: 'company', label: 'Company', maxLength: 100 },
          { key: 'role_title', label: 'Role', maxLength: 100 },
        ],
      },
    } as ScenarioConfigInput);
    const s = await this.prisma.scenario.create({
      data: { workspaceId, slug: `s-${this.uid()}`, name: config.basics.name, type: 'interview', privacy, status: 'PUBLISHED' },
    });
    const v = await this.prisma.scenarioVersion.create({
      data: { scenarioId: s.id, workspaceId, version: 1, config: config as any, configHash: this.uid() },
    });
    await this.prisma.scenario.update({ where: { id: s.id }, data: { latestVersionId: v.id, latestVersionNumber: 1 } });
    return { ...s, latestVersionId: v.id, versionId: v.id };
  }

  /** Minimal org fixture: owner, admin, creator, reviewer, member + a published scenario. */
  async org() {
    const owner = await this.user('Owner');
    const ws = await this.workspace(owner);
    const admin = await this.member(ws.id, 'ADMIN');
    const creator = await this.member(ws.id, 'CREATOR');
    const reviewer = await this.member(ws.id, 'REVIEWER');
    const learner = await this.member(ws.id, 'MEMBER');
    const scenario = await this.scenario(ws.id);
    const ownerMembership = await this.prisma.membership.findFirstOrThrow({ where: { workspaceId: ws.id, userId: owner.id } });
    return { ws, owner: { ...owner, membershipId: ownerMembership.id }, admin, creator, reviewer, learner, scenario };
  }
}
