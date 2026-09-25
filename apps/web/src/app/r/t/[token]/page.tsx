'use client';
import { useParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { LandingFallback, RunLanding, type LandingInfo, type StartPayload } from '@/components/access/RunLanding';
import { api } from '@/lib/api';

/**
 * Personal invitation link: /r/t/<cfp_token>. The token is sent as a bearer header (never in an API
 * URL); identity comes from the token and the link is single-use by default.
 */
export default function ParticipantInvitePage() {
  const { token } = useParams<{ token: string }>();
  const t = decodeURIComponent(token);
  const load = useCallback(() => api<LandingInfo>('/public/participant-tokens/info', { token: t }), [t]);
  const start = useCallback(
    (body: StartPayload) =>
      api<{ sessionId: string; sessionToken: string }>('/public/participant-tokens/sessions', {
        method: 'POST',
        token: t,
        body: { name: body.name, variables: body.variables },
      }),
    [t],
  );
  return (
    <Suspense fallback={<LandingFallback />}>
      <RunLanding load={load} start={start} />
    </Suspense>
  );
}
