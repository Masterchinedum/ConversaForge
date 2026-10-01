'use client';
import { useEffect, useState } from 'react';
import { ButtonLink } from '@/components/ui';
import type { SessionState } from '@cf/shared';
import { formatClock } from './branding';
import { StatusScreen } from './Shell';

const COPY: Partial<Record<SessionState, { title: string; body: string; tone: 'success' | 'info' | 'error' }>> = {
  COMPLETED: { title: 'Thanks — your conversation is complete', body: 'Your session has been saved.', tone: 'success' },
  ENDING: { title: 'Thanks — your conversation is complete', body: 'Your session is being saved.', tone: 'success' },
  FAILED: {
    title: 'The conversation ended unexpectedly',
    body: 'Something went wrong on our side and the session had to stop. What you said so far has been saved.',
    tone: 'error',
  },
  ABANDONED: {
    title: 'This session was closed',
    body: 'The connection was lost for too long, so the session was closed. What you said before the disconnection has been saved.',
    tone: 'info',
  },
  EXPIRED: { title: 'This session has expired', body: 'Ask the organizer for a new link to start again.', tone: 'info' },
  CANCELLED: { title: 'This session was cancelled', body: 'Ask the organizer for a new link if you still need to take part.', tone: 'info' },
};

export function EndScreen({
  sessionId,
  state,
  reason,
  durationMs,
  showFeedbackLink,
  returnUrl,
  embedded,
}: {
  sessionId: string;
  state: SessionState | null;
  reason?: string | null;
  durationMs?: number | null;
  showFeedbackLink: boolean;
  returnUrl?: string | null;
  embedded?: boolean;
}) {
  const copy = (state && COPY[state]) ?? COPY.COMPLETED!;
  const completed = state === 'COMPLETED' || state === 'ENDING' || !state;
  // "Play All" in a course: continue automatically after a short, cancellable countdown.
  const autoContinue = !!returnUrl && /[?&]playAll=1\b/.test(returnUrl) && !embedded;
  const [countdown, setCountdown] = useState<number | null>(autoContinue ? 8 : null);
  useEffect(() => {
    if (countdown === null || !returnUrl) return;
    if (countdown <= 0) {
      window.location.assign(returnUrl);
      return;
    }
    const t = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000);
    return () => clearTimeout(t);
  }, [countdown, returnUrl]);
  return (
    <div data-testid="end-screen" data-state={state ?? ''}>
      <StatusScreen
        title={copy.title}
        tone={copy.tone}
        actions={
          <>
            {showFeedbackLink && completed && (
              <ButtonLink href={`/report/${encodeURIComponent(sessionId)}`} {...(embedded ? { target: '_blank' } : {})}>
                View your feedback
              </ButtonLink>
            )}
            {returnUrl && (
              <ButtonLink href={returnUrl} variant="secondary">
                {countdown !== null ? `Continue course (${countdown})` : 'Back to course'}
              </ButtonLink>
            )}
            {countdown !== null && (
              <button type="button" className="text-sm text-slate-600 underline" onClick={() => setCountdown(null)}>
                Stay on this page
              </button>
            )}
          </>
        }
      >
        <p>{copy.body}</p>
        {durationMs ? <p className="mt-2">Duration: {formatClock(durationMs)}</p> : null}
        {reason && !completed && <p className="mt-2 text-xs text-slate-500">Reason: {reason}</p>}
        {showFeedbackLink && completed && <p className="mt-2">Your feedback will be ready in a minute or two.</p>}
      </StatusScreen>
    </div>
  );
}
