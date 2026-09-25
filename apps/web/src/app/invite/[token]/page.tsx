'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { mutate } from 'swr';
import { Alert, Badge, Button, ButtonLink, Loading } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/workspace';

interface Preview {
  workspace: { id: string; name: string; logoUrl: string | null };
  inviter: string | null;
  role: string;
  email: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
}

/** /invite/<token>: preview an organization invitation and accept it (login/signup first if needed). */
export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const { data: me, error: meError, isLoading: meLoading } = useMe();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState<string | null>(null);

  useEffect(() => {
    api<Preview>(`/invitations/${encodeURIComponent(token)}`)
      .then(setPreview)
      .catch((e) => setError(e instanceof ApiError && e.status === 404 ? 'This invitation link is invalid or has been replaced by a newer one.' : errorMessage(e)));
  }, [token]);

  const next = `/invite/${token}`;
  const loggedIn = !!me && !meError;
  const emailMatches = loggedIn && preview && me.user.email.toLowerCase() === preview.email.toLowerCase();

  const accept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      const r = await api<{ workspaceId: string }>(`/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST' });
      // Refresh the cached membership list first, or the workspace page would not know the new workspace yet.
      await mutate('/auth/me');
      router.replace(`/w/${r.workspaceId}`);
    } catch (e) {
      setAcceptError(errorMessage(e));
      setAccepting(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 px-4 py-12">
      <div className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {error ? (
          <div className="text-center" role="alert">
            <h1 className="text-lg font-semibold">Invitation not found</h1>
            <p className="mt-2 text-sm text-slate-600">{error}</p>
            <Link href="/app" className="mt-4 inline-block text-sm text-brand-700 hover:underline">
              Go to ConversaForge
            </Link>
          </div>
        ) : !preview || meLoading ? (
          <Loading />
        ) : (
          <div className="space-y-4">
            {preview.workspace.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview.workspace.logoUrl} alt="" className="mx-auto h-10 object-contain" />
            )}
            <h1 className="text-center text-lg font-semibold">Join {preview.workspace.name}</h1>
            <p className="text-center text-sm text-slate-600">
              {preview.inviter ? `${preview.inviter} invited you` : 'You were invited'} to join as <Badge tone="blue">{preview.role.toLowerCase()}</Badge>
            </p>
            <p className="text-center text-xs text-slate-500">Invitation for {preview.email}</p>

            {preview.status !== 'pending' ? (
              <Alert tone="warning" title={preview.status === 'accepted' ? 'Already accepted' : preview.status === 'expired' ? 'This invitation has expired' : 'This invitation was revoked'}>
                {preview.status === 'accepted' ? (
                  <Link className="underline" href={`/w/${preview.workspace.id}`}>
                    Open the workspace
                  </Link>
                ) : (
                  'Ask an administrator of the workspace to send you a new invitation.'
                )}
              </Alert>
            ) : !loggedIn ? (
              <div className="space-y-2">
                <p className="text-sm text-slate-600">Sign in or create an account with {preview.email} to accept.</p>
                <ButtonLink href={`/signup?next=${encodeURIComponent(next)}`} className="w-full">
                  Create account
                </ButtonLink>
                <ButtonLink href={`/login?next=${encodeURIComponent(next)}`} variant="secondary" className="w-full">
                  I already have an account
                </ButtonLink>
              </div>
            ) : !emailMatches ? (
              <Alert tone="warning" title="Different account">
                You are signed in as {me.user.email}, but this invitation was sent to {preview.email}. Sign out and sign in with the invited email.
                <div className="mt-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={async () => {
                      await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
                      window.location.href = `/login?next=${encodeURIComponent(next)}`;
                    }}
                  >
                    Switch account
                  </Button>
                </div>
              </Alert>
            ) : (
              <div className="space-y-2">
                {acceptError && <Alert tone="error">{acceptError}</Alert>}
                <Button className="w-full" onClick={accept} loading={accepting}>
                  Accept invitation
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
