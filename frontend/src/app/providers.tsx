'use client';
import { SWRConfig } from 'swr';
import { ToastProvider } from '@/components/ui';
import { fetcher } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        fetcher,
        // Always refetch when a view mounts (e.g. switching tabs) so lists never show stale data after
        // changes made elsewhere; focus revalidation stays off so in-progress edits are never clobbered.
        revalidateOnMount: true,
        // Collapse duplicate requests from one render, but don't serve a response older than 0.5 s
        // to a view that just mounted (the 2 s default showed stale lists on quick tab switches).
        dedupingInterval: 500,
        revalidateOnFocus: false,
        shouldRetryOnError: false,
      }}
    >
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}
