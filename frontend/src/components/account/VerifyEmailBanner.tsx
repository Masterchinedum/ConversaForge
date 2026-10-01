'use client';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';

/** Shown while the account email is unverified: email grants and email-assigned courses stay locked until then. */
export function VerifyEmailBanner({ email }: { email: string }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span>
        Please verify <strong>{email}</strong> — check your inbox for the link. Content shared with this address stays hidden until it is verified.
      </span>
      <button
        type="button"
        className="font-medium underline disabled:opacity-50"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const r = await api<{ sent: boolean; alreadyVerified: boolean }>('/auth/resend-verification', { method: 'POST' });
            setMsg(r.alreadyVerified ? 'Already verified — reload the page.' : 'Verification email sent.');
          } catch (e) {
            setMsg(errorMessage(e));
          } finally {
            setBusy(false);
          }
        }}
      >
        Resend link
      </button>
      {msg && <span aria-live="polite">{msg}</span>}
    </div>
  );
}
