'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { mutate } from 'swr';
import { Alert, Loading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

function VerifyEmail() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<{ k: 'working' } | { k: 'done'; email: string } | { k: 'error'; message: string }>({ k: 'working' });
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    if (!token) {
      setState({ k: 'error', message: 'This verification link is incomplete. Open the link from the email again.' });
      return;
    }
    api<{ ok: true; email: string }>('/auth/verify-email', { method: 'POST', body: { token } })
      .then((r) => {
        setState({ k: 'done', email: r.email });
        void mutate('/auth/me');
      })
      .catch((e) => setState({ k: 'error', message: errorMessage(e) }));
  }, [token]);

  if (state.k === 'working') return <Loading />;
  if (state.k === 'error')
    return (
      <div className="space-y-3">
        <h1 className="text-lg font-semibold">Email not verified</h1>
        <Alert tone="error">{state.message}</Alert>
        <p className="text-sm text-slate-600">
          Sign in and request a new link from the banner at the top of your workspace, or from your <Link href="/account" className="text-brand-700 underline">account page</Link>.
        </p>
      </div>
    );
  return (
    <div className="space-y-3">
      <h1 className="text-lg font-semibold">Email verified</h1>
      <Alert tone="success">{state.email} is confirmed. Items shared with this address are now available in your account.</Alert>
      <Link href="/app" className="text-sm text-brand-700 hover:underline">
        Continue to ConversaForge
      </Link>
    </div>
  );
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmail />
    </Suspense>
  );
}
