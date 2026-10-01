/**
 * Webhook retry policy. Attempt 1 is immediate; after a failed attempt n the next one is scheduled
 * RETRY_DELAYS_MS[n-1] later. After MAX_ATTEMPTS failures the delivery is FAILED.
 *
 *   attempt:  1    2     3     4      5    6    7     8
 *   at:       0   +1m   +5m   +30m   +2h  +6h  +12h  +12h   (≈ 33 h total)
 */
export const MAX_ATTEMPTS = 8;
export const RETRY_DELAYS_MS = [
  60_000, // 1 min
  5 * 60_000, // 5 min
  30 * 60_000, // 30 min
  2 * 3600_000, // 2 h
  6 * 3600_000, // 6 h
  12 * 3600_000, // 12 h
  12 * 3600_000, // 12 h
] as const;

export const DELIVERY_TIMEOUT_MS = 10_000;

/** Delay before attempt `attempt + 1`, or null when `attempt` was the last one. */
export function nextRetryDelayMs(attempt: number, jitter = 0): number | null {
  if (attempt >= MAX_ATTEMPTS) return null;
  const base = RETRY_DELAYS_MS[Math.max(0, attempt - 1)] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
  // jitter in [0,1): spread retries by up to +10% so a recovering endpoint is not stampeded.
  return Math.round(base * (1 + 0.1 * Math.min(Math.max(jitter, 0), 0.999)));
}

export type AttemptOutcome = { ok: true; statusCode: number } | { ok: false; statusCode: number | null; error: string };

export interface DeliveryDecision {
  status: 'SUCCEEDED' | 'RETRYING' | 'FAILED';
  nextAttemptAt: Date | null;
  /** Subscription failure counter after this attempt (consecutive deliveries that ended FAILED). */
  failureCount: number;
  /** Subscription must be auto-disabled now. */
  disable: boolean;
}

/**
 * Pure state transition for one attempt. Manual attempts (redeliver / test ping) never schedule
 * automatic retries and never count towards auto-disable, but a manual success resets the counter.
 */
export function decideAfterAttempt(input: {
  attempt: number;
  manual: boolean;
  outcome: AttemptOutcome;
  failureCount: number;
  disableAfter: number;
  now?: Date;
  jitter?: number;
}): DeliveryDecision {
  const now = input.now ?? new Date();
  if (input.outcome.ok) return { status: 'SUCCEEDED', nextAttemptAt: null, failureCount: 0, disable: false };
  if (input.manual) return { status: 'FAILED', nextAttemptAt: null, failureCount: input.failureCount, disable: false };
  const delay = nextRetryDelayMs(input.attempt, input.jitter ?? 0);
  if (delay !== null) {
    return { status: 'RETRYING', nextAttemptAt: new Date(now.getTime() + delay), failureCount: input.failureCount, disable: false };
  }
  const failureCount = input.failureCount + 1;
  return { status: 'FAILED', nextAttemptAt: null, failureCount, disable: failureCount >= input.disableAfter };
}

/** 2xx is success; everything else (incl. redirects) is a failure. */
export function isSuccessStatus(code: number): boolean {
  return code >= 200 && code < 300;
}
