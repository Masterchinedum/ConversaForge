'use client';
import { useParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { LandingFallback, RunLanding, type LandingInfo, type StartPayload } from '@/components/access/RunLanding';
import { api } from '@/lib/api';

/** Share-link landing: /r/<token>. `?var_<key>=` query params are forwarded as variables. */
export default function ShareLinkPage() {
  const { token } = useParams<{ token: string }>();
  const load = useCallback(() => api<LandingInfo>(`/public/links/${encodeURIComponent(token)}`), [token]);
  const start = useCallback(
    (body: StartPayload) => api<{ sessionId: string; sessionToken: string }>(`/public/links/${encodeURIComponent(token)}/sessions`, { method: 'POST', body: body as Record<string, unknown> }),
    [token],
  );
  return (
    <Suspense fallback={<LandingFallback />}>
      <RunLanding load={load} start={start} />
    </Suspense>
  );
}
