import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { workerRuntime } from '../../common/queue/queue.service';
import { DomainEvents } from '../../common/events/domain-events';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UsageService } from '../usage/usage.service';
import { ClientConfigService } from './client-config.service';
import { PAUSE_TIMEOUT_MS, SessionEngine, type EngineDeps } from './engine/session-engine';
import type { EngineConnection, EngineTransport } from './engine/transport';
import { OptionalDepsService } from './optional-deps.service';
import { SessionsService } from './sessions.service';
import { ToolRegistry } from './tools/tool-registry';
import { ProviderResolverService } from './voice/provider-resolver.service';

const SWEEP_INTERVAL_MS = 60_000;
/** A live session whose engine has not heart-beaten for this long is orphaned (its API process died). */
const ORPHAN_AFTER_MS = 3 * 60_000;
const UNSTARTED_EXPIRY_MS = 24 * 3600_000;

/**
 * Registry of live session engines in this API process + the transport-agnostic entry point.
 *
 *   attach(sessionId, sessionToken, transport, { lastSeq?, clientInstanceId? }) → EngineConnection
 *
 * The browser WebSocket gateway and the phone/meeting bridges (workstream H) both use it.
 * Engines are rebuilt from the database on demand (e.g. after an API restart).
 * Deployment note: engines live in memory, so run a single API instance or route /ws/session and
 * phone streams with session affinity (sticky by sessionId). The sweeper is multi-instance safe
 * (heartbeat + compare-and-set state transitions).
 */
@Injectable()
export class RuntimeService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Runtime');
  private readonly engines = new Map<string, SessionEngine>();
  private readonly building = new Map<string, Promise<SessionEngine>>();
  private sweepHandle: NodeJS.Timeout | null = null;
  private readonly deps: EngineDeps;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
    usage: UsageService,
    events: DomainEvents,
    tools: ToolRegistry,
    optional: OptionalDepsService,
    providers: ProviderResolverService,
    clientConfig: ClientConfigService,
  ) {
    this.deps = {
      prisma,
      usage,
      events,
      tools,
      optional,
      providers,
      buildClientConfig: (s, c) => clientConfig.build(s, c),
      onDisposed: (id) => {
        const e = this.engines.get(id);
        if (e?.isDisposed) this.engines.delete(id);
      },
    };
  }

  onModuleInit() {
    // Sweep only in processes that run background work (API with in-process workers, or the worker).
    if (!workerRuntime.enabled || process.env.NODE_ENV === 'test') return;
    this.sweepHandle = setInterval(() => void this.sweep().catch((e) => this.logger.error(`sweep failed: ${e.message}`)), SWEEP_INTERVAL_MS);
    this.sweepHandle.unref?.();
  }

  /**
   * Shutdown/redeploy: stop engines without touching session state. Live sessions stay ACTIVE in the
   * database; clients reconnect and the engine is rebuilt (time is folded up to the last heartbeat).
   */
  onModuleDestroy() {
    if (this.sweepHandle) clearInterval(this.sweepHandle);
    for (const e of this.engines.values()) e.dispose();
    this.engines.clear();
  }

  /** Authenticate with the session token and attach a transport. Throws 401/404 on bad credentials. */
  async attach(
    sessionId: string,
    token: string,
    transport: EngineTransport,
    opts: { lastSeq?: number; clientInstanceId?: string } = {},
  ): Promise<EngineConnection> {
    await this.sessions.verifySessionToken(sessionId, token);
    const engine = await this.getEngine(sessionId);
    return engine.attach(transport, opts);
  }

  /** Get (or rebuild from the database) the engine for a session. */
  async getEngine(sessionId: string): Promise<SessionEngine> {
    const existing = this.engines.get(sessionId);
    if (existing && !existing.isDisposed) return existing;
    const pending = this.building.get(sessionId);
    if (pending) return pending;
    const p = (async () => {
      const loaded = await this.sessions.load(sessionId);
      const engine = await SessionEngine.build(this.deps, loaded.session, loaded.config, loaded.scenario.name);
      this.engines.set(sessionId, engine);
      return engine;
    })().finally(() => this.building.delete(sessionId));
    this.building.set(sessionId, p);
    return p;
  }

  /** Engine if loaded in this process (no rebuild). */
  peek(sessionId: string): SessionEngine | null {
    const e = this.engines.get(sessionId);
    return e && !e.isDisposed ? e : null;
  }

  activeCount() {
    return this.engines.size;
  }

  /**
   * Finalize sessions nobody is driving any more: orphaned live sessions (no heartbeat), sessions paused
   * for too long, and sessions created but never started (expired token).
   */
  async sweep(now = new Date()) {
    const orphanBefore = new Date(now.getTime() - ORPHAN_AFTER_MS);
    const pausedBefore = new Date(now.getTime() - PAUSE_TIMEOUT_MS - 60_000);
    const unstartedBefore = new Date(now.getTime() - UNSTARTED_EXPIRY_MS);
    const candidates = await this.prisma.session.findMany({
      where: {
        deletedAt: null,
        OR: [
          { state: { in: ['ACTIVE', 'CONNECTING', 'RECONNECTING', 'ENDING'] }, updatedAt: { lt: orphanBefore } },
          { state: 'PAUSED', updatedAt: { lt: pausedBefore } },
          { state: { in: ['CREATED', 'READY'] }, createdAt: { lt: unstartedBefore } },
        ],
      },
      select: { id: true, state: true },
      take: 100,
    });
    for (const c of candidates) {
      if (this.peek(c.id)) continue; // this process is driving it (its own timers apply)
      try {
        const engine = await this.getEngine(c.id);
        await engine.abandon(c.state === 'CREATED' || c.state === 'READY' ? 'expired_unstarted' : 'orphaned');
        this.logger.log(`Swept session ${c.id} (${c.state} → ${engine.currentState})`);
      } catch (e) {
        this.logger.warn(`Could not sweep session ${c.id}: ${(e as Error).message}`);
      }
    }
    return candidates.length;
  }
}
