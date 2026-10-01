'use client';
import { LiveApp } from '@/components/live/LiveApp';
import { Loading } from '@/components/ui';
import { safeReturnUrl } from '@/lib/live/token';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';

function LivePage() {
  const params = useParams<{ sessionId: string }>();
  const search = useSearchParams();
  const returnUrl = safeReturnUrl(search.get('return'));
  return <LiveApp sessionId={params.sessionId} returnUrl={returnUrl} />;
}

export default function Page() {
  return (
    <Suspense fallback={<Loading />}>
      <LivePage />
    </Suspense>
  );
}
