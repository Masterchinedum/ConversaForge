'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { Loading } from '@/components/ui';
import { useMe } from '@/lib/workspace';

/** Entry point after login: go to the last-used workspace (or the first one). */
export default function AppRedirect() {
  const router = useRouter();
  const { data, error } = useMe();
  useEffect(() => {
    if (error) router.replace('/login?next=/app');
    if (!data) return;
    let last: string | null = null;
    try {
      last = localStorage.getItem('cf:lastWorkspace');
    } catch {
      /* ignore */
    }
    const target = data.workspaces.find((w) => w.id === last) ?? data.workspaces[0];
    router.replace(target ? `/w/${target.id}` : '/w/new');
  }, [data, error, router]);
  return <Loading label="Opening your workspace…" />;
}
