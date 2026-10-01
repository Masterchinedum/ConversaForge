import { Prisma } from '@prisma/client';
import { assertTransition, type SessionState } from '@cf/shared';
import type { DomainEvents } from '../../common/events/domain-events';
import type { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Lifecycle for passive MEETING sessions (a Recall.ai bot transcribes a real meeting; no AI agent
 * speaks, so the conversation engine is not attached). Transitions follow the shared state machine,
 * use compare-and-set updates and emit the same DomainEvents the runtime emits, so analysis,
 * webhooks and courses treat meeting sessions like any other session.
 */
export async function transitionMeetingSession(
  prisma: PrismaService,
  events: DomainEvents,
  sessionId: string,
  to: SessionState,
  reason: string,
  extra: { errorCode?: string; errorMessage?: string; endedBy?: string } = {},
): Promise<boolean> {
  const s = await prisma.session.findUnique({ where: { id: sessionId } });
  if (!s || s.channel !== 'MEETING') return false;
  const path = pathTo(s.state as SessionState, to);
  if (!path) return false;
  let current = s.state as SessionState;
  for (const next of path) {
    assertTransition(current, next);
    const now = new Date();
    const data: Prisma.SessionUpdateManyMutationInput = { state: next, stateReason: reason };
    if (next === 'ACTIVE' && !s.startedAt) data.startedAt = now;
    if (next === 'COMPLETED' || next === 'FAILED' || next === 'CANCELLED') {
      data.endedAt = now;
      data.endedBy = extra.endedBy ?? 'system';
      const started = s.startedAt ?? (current === 'ACTIVE' || current === 'ENDING' ? now : null);
      if (started) data.durationMs = Math.max(0, now.getTime() - started.getTime());
      if (extra.errorCode) data.errorCode = extra.errorCode;
      if (extra.errorMessage) data.errorMessage = extra.errorMessage.slice(0, 500);
      data.resumeExpiresAt = now;
    }
    const res = await prisma.session.updateMany({ where: { id: sessionId, state: current }, data });
    if (!res.count) return false; // someone else moved it
    await prisma.sessionEvent.create({
      data: { sessionId, type: 'state.changed', payload: { from: current, to: next, reason } as Prisma.InputJsonValue },
    });
    if (next === 'ACTIVE' && !s.startedAt) events.emit('session.started', { sessionId, workspaceId: s.workspaceId });
    if (next === 'COMPLETED' || next === 'FAILED' || next === 'CANCELLED') {
      events.emit('session.terminal', { sessionId, workspaceId: s.workspaceId, state: next });
    }
    current = next;
  }
  return true;
}

/** Shortest legal path through the state machine for the meeting lifecycle. */
export function pathTo(from: SessionState, to: SessionState): SessionState[] | null {
  if (from === to) return [];
  const routes: Record<string, SessionState[]> = {
    'CREATED>ACTIVE': ['READY', 'CONNECTING', 'ACTIVE'],
    'READY>ACTIVE': ['CONNECTING', 'ACTIVE'],
    'CONNECTING>ACTIVE': ['ACTIVE'],
    'ACTIVE>COMPLETED': ['ENDING', 'COMPLETED'],
    'CONNECTING>COMPLETED': ['ENDING', 'COMPLETED'],
    'ENDING>COMPLETED': ['COMPLETED'],
    'CREATED>CANCELLED': ['CANCELLED'],
    'READY>CANCELLED': ['CANCELLED'],
    'CONNECTING>CANCELLED': ['CANCELLED'],
    'CREATED>FAILED': ['FAILED'],
    'READY>FAILED': ['FAILED'],
    'CONNECTING>FAILED': ['FAILED'],
    'ACTIVE>FAILED': ['FAILED'],
    'ENDING>FAILED': ['FAILED'],
  };
  return routes[`${from}>${to}`] ?? null;
}
