'use client';
import { SWRConfig } from 'swr';
import { ToastProvider } from '@/components/ui';
import { fetcher } from '@/lib/api';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig value={{ fetcher, revalidateOnFocus: false, shouldRetryOnError: false }}>
      <ToastProvider>{children}</ToastProvider>
    </SWRConfig>
  );
}
