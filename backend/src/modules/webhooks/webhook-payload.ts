import { createHash } from 'node:crypto';
import type { WebhookEventType } from '@cf/shared';

/** Public webhook event types plus the synthetic `ping` used by "Send test". */
export type DeliverableEventType = WebhookEventType | 'ping';

export interface WebhookSessionData {
  id: string;
  scenarioId: string;
  scenarioVersionId: string;
  versionNumber: number;
  state: string;
  channel: string;
  participant: { id: string; externalId: string | null; email: string | null; name: string | null };
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  metadata: Record<string, unknown>;
}

export interface WebhookEvaluationData {
  id: string;
  overallScore: number | null;
  scoredWeightPct: number | null;
  insufficientEvidence: boolean;
  humanReviewRequired: boolean;
  simulated: boolean;
  criteria: Array<{
    criterionId: string;
    name: string;
    weight: number;
    score: number | null;
    insufficientEvidence: boolean;
    confidence: number | null;
  }>;
}

export interface WebhookExtractionItem {
  key: string;
  type: string;
  value: unknown;
  valid: boolean;
  confidence: number | null;
  simulated: boolean;
}

export interface WebhookEventPayload {
  id: string;
  type: DeliverableEventType;
  createdAt: string;
  workspaceId: string;
  data: {
    session?: WebhookSessionData;
    evaluation?: WebhookEvaluationData | null;
    extraction?: WebhookExtractionItem[];
    failure?: { stage: 'session' | 'analysis'; errorCode: string | null; message: string | null };
    ping?: { message: string; subscriptionId: string };
  };
}

/**
 * Deterministic public event id: one OutboxEvent per (workspace, session, type, variant), so
 * duplicate domain events and job retries never produce a second event.
 */
export function outboxEventId(workspaceId: string, sessionId: string, type: string, variant = ''): string {
  return 'evt_' + createHash('sha256').update(`${workspaceId}|${sessionId}|${type}|${variant}`).digest('hex').slice(0, 24);
}

/**
 * Map a runtime terminal state to a public event.
 *   COMPLETED → session.completed
 *   ABANDONED → session.completed (data.session.state = "ABANDONED"; the partial conversation is analysed)
 *   FAILED    → session.failed (failure.stage = "session")
 *   CANCELLED / EXPIRED → no event (the conversation never took place)
 */
export function terminalStateToEvent(state: string): { type: WebhookEventType; variant: string } | null {
  switch (state) {
    case 'COMPLETED':
    case 'ABANDONED':
      return { type: 'session.completed', variant: '' };
    case 'FAILED':
      return { type: 'session.failed', variant: 'session' };
    default:
      return null;
  }
}
