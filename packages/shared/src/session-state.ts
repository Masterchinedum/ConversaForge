/**
 * Session lifecycle state machine. The API is the only writer; transitions are validated here so the
 * web client can render the same rules.
 *
 *   CREATED ──consent──▶ READY ──connect──▶ CONNECTING ──▶ ACTIVE ⇄ PAUSED
 *                                                     ACTIVE ⇄ RECONNECTING
 *   ACTIVE|PAUSED|RECONNECTING ──end──▶ ENDING ──▶ COMPLETED
 *   any non-terminal ──error──▶ FAILED
 *   CREATED|READY ──▶ CANCELLED | EXPIRED
 *   RECONNECTING|PAUSED (timed out) ──▶ ABANDONED
 */

export const SESSION_STATES = [
  'CREATED',
  'READY',
  'CONNECTING',
  'ACTIVE',
  'PAUSED',
  'RECONNECTING',
  'ENDING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
  'ABANDONED',
] as const;
export type SessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: readonly SessionState[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED'];

/** Terminal states that should trigger the post-session pipeline (there may be a partial transcript). */
export const ANALYZABLE_TERMINAL_STATES: readonly SessionState[] = ['COMPLETED', 'ABANDONED', 'FAILED'];

export const SESSION_TRANSITIONS: Record<SessionState, readonly SessionState[]> = {
  CREATED: ['READY', 'CANCELLED', 'EXPIRED', 'FAILED'],
  READY: ['CONNECTING', 'CANCELLED', 'EXPIRED', 'FAILED'],
  CONNECTING: ['ACTIVE', 'RECONNECTING', 'FAILED', 'CANCELLED', 'ENDING'],
  ACTIVE: ['PAUSED', 'RECONNECTING', 'ENDING', 'FAILED'],
  PAUSED: ['ACTIVE', 'ENDING', 'RECONNECTING', 'FAILED', 'ABANDONED'],
  RECONNECTING: ['ACTIVE', 'PAUSED', 'ENDING', 'FAILED', 'ABANDONED'],
  ENDING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  ABANDONED: [],
};

export function isTerminal(state: SessionState): boolean {
  return TERMINAL_STATES.includes(state);
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: SessionState,
    public readonly to: SessionState,
  ) {
    super(`Invalid session transition ${from} → ${to}`);
  }
}

export function assertTransition(from: SessionState, to: SessionState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** States in which the participant is considered "in the call" for billing/timing. */
export const LIVE_STATES: readonly SessionState[] = ['ACTIVE', 'PAUSED', 'RECONNECTING', 'ENDING'];
