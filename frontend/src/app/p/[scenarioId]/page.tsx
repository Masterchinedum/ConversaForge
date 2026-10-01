'use client';
import { useParams } from 'next/navigation';
import { Suspense, useCallback } from 'react';
import { LandingFallback, RunLanding, type LandingInfo, type StartPayload } from '@/components/access/RunLanding';
import { api } from '@/lib/api';

/** Public scenario run page: /p/<scenarioId> (privacy PUBLIC + published; rate-limited). */
export default function PublicScenarioPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const load = useCallback(() => api<LandingInfo>(`/public/scenarios/${encodeURIComponent(scenarioId)}`), [scenarioId]);
  const start = useCallback(
    (body: StartPayload) =>
      api<{ sessionId: string; sessionToken: string }>(`/public/scenarios/${encodeURIComponent(scenarioId)}/sessions`, {
        method: 'POST',
        body: { name: body.name, email: body.email, variables: body.variables },
      }),
    [scenarioId],
  );
  return (
    <Suspense fallback={<LandingFallback />}>
      <RunLanding load={load} start={start} />
    </Suspense>
  );
}
