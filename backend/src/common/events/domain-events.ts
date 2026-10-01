import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { EventEmitter } from 'node:events';

/**
 * In-process domain events between modules (e.g. runtime → analysis pipeline → courses/webhooks).
 * Durable side effects must be enqueued as BullMQ jobs by the listener; listeners must be idempotent.
 */
export interface DomainEventMap {
  'session.started': { sessionId: string; workspaceId: string };
  /** Session reached a terminal state (COMPLETED/FAILED/ABANDONED/CANCELLED/EXPIRED). */
  'session.terminal': { sessionId: string; workspaceId: string; state: string };
  'session.analyzed': { sessionId: string; workspaceId: string; evaluationId: string | null; overallScore: number | null };
  'session.extracted': { sessionId: string; workspaceId: string };
  'session.failed': { sessionId: string; workspaceId: string; errorCode: string | null };
  'knowledge.uploaded': { documentId: string; workspaceId: string };
  'usage.recorded': { workspaceId: string; sessionId: string | null };
}

@Injectable()
export class DomainEvents {
  private readonly emitter = new EventEmitter();
  private readonly logger = new Logger('DomainEvents');

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<K extends keyof DomainEventMap>(event: K, payload: DomainEventMap[K]) {
    for (const listener of this.emitter.listeners(event)) {
      Promise.resolve()
        .then(() => (listener as (p: DomainEventMap[K]) => unknown)(payload))
        .catch((e) => this.logger.error(`Listener for ${String(event)} failed: ${e?.message ?? e}`));
    }
  }

  on<K extends keyof DomainEventMap>(event: K, listener: (payload: DomainEventMap[K]) => unknown) {
    this.emitter.on(event, listener);
  }
}

@Global()
@Module({ providers: [DomainEvents], exports: [DomainEvents] })
export class DomainEventsModule {}
