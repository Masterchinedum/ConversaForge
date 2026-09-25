'use client';
/**
 * Participant landing for share links (/r/<token>), personal invitations (/r/t/<token>) and public
 * scenarios (/p/<id>). Shows branding + scenario info, collects identity/passcode/variables as the
 * link requires, creates the session, stores the session token (ARCHITECTURE.md) and opens /live/<id>.
 */
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Field, Input, Loading, Spinner } from '@/components/ui';
import { brandStyle } from '@/components/live/branding';
import { ApiError } from '@/lib/api';
import { storeSessionToken } from '@/lib/live/token';

export interface LandingInfo {
  kind: 'link' | 'public' | 'invite';
  scenario: {
    id: string;
    name: string;
    type: string;
    description: string;
    participantInstructions: string;
    language: string;
    durationMinutes: number;
    maxDurationMinutes: number;
    personaName: string;
    recording: { audio: boolean; video: boolean };
  };
  access: {
    identityMode: 'NONE' | 'NAME' | 'EMAIL' | 'NAME_EMAIL';
    requiresName: boolean;
    requiresEmail: boolean;
    passcodeRequired: boolean;
    allowedEmailDomains: string[];
    attemptLimitPerEmail: number | null;
    oneTime: boolean;
    expiresAt: string | null;
    label: string | null;
  };
  participant?: { name: string | null; email: string | null };
  variables: Array<{ key: string; label: string; description: string; required: boolean; maxLength: number }>;
  branding: {
    workspaceName: string;
    displayName: string;
    logoUrl: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    supportEmail: string | null;
    hidePoweredBy: boolean;
  };
}

export interface StartPayload {
  name?: string;
  email?: string;
  passcode?: string;
  variables?: Record<string, string>;
}

const FRIENDLY: Record<string, { title: string; body: string }> = {
  link_revoked: { title: 'This link is no longer active', body: 'The organizer has turned this link off. Ask them for a new one.' },
  link_expired: { title: 'This link has expired', body: 'Ask the organizer for a new link if you still need access.' },
  link_exhausted: { title: 'This link has already been used', body: 'It has reached its maximum number of uses. Ask the organizer for a new link.' },
  token_revoked: { title: 'This invitation is no longer active', body: 'The organizer has revoked it. Ask them for a new invitation.' },
  token_expired: { title: 'This invitation has expired', body: 'Ask the organizer to send you a new invitation.' },
  token_exhausted: { title: 'This invitation has already been used', body: 'Personal links work once. Ask the organizer for a new one if you need another attempt.' },
  scenario_unavailable: { title: 'This conversation is not available', body: 'It may have been archived or unpublished by the organizer.' },
  not_found: { title: 'Link not found', body: 'Check that you copied the whole link, or ask the organizer for a new one.' },
  unauthorized: { title: 'Invalid invitation link', body: 'Check that you copied the whole link, or ask the organizer for a new one.' },
  rate_limited: { title: 'Too many requests', body: 'Please wait a few minutes and try again.' },
};

/** Collect `?var_<key>=value` parameters (forwarded as participant-supplied variables). */
export function urlVariables(params: URLSearchParams | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!params) return out;
  params.forEach((v, k) => {
    if (k.startsWith('var_') && k.length > 4 && k.length <= 52 && v) out[k.slice(4)] = v.slice(0, 2000);
  });
  return out;
}

export function RunLanding({ load, start }: { load: () => Promise<LandingInfo>; start: (p: StartPayload) => Promise<{ sessionId: string; sessionToken: string }> }) {
  const router = useRouter();
  const search = useSearchParams();
  const fromUrl = useMemo(() => urlVariables(search), [search]);
  const [info, setInfo] = useState<LandingInfo | null>(null);
  const [loadError, setLoadError] = useState<ApiError | Error | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [passcode, setPasscode] = useState('');
  const [vars, setVars] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; field?: string; fatal?: boolean } | null>(null);

  const reload = useCallback(() => {
    setLoadError(null);
    load()
      .then((i) => {
        setInfo(i);
        if (i.participant?.name) setName(i.participant.name);
      })
      .catch((e) => setLoadError(e));
  }, [load]);
  useEffect(reload, [reload]);

  if (loadError) {
    const code = loadError instanceof ApiError ? loadError.code : 'error';
    const f = FRIENDLY[code] ?? { title: 'Something went wrong', body: loadError.message };
    return (
      <Frame>
        <div className="py-8 text-center" role="alert">
          <h1 className="text-lg font-semibold text-slate-900">{f.title}</h1>
          <p className="mt-2 text-sm text-slate-600">{f.body}</p>
          {code !== 'link_revoked' && code !== 'not_found' && !code.startsWith('token_') && !code.startsWith('link_') && (
            <Button variant="secondary" className="mt-4" onClick={reload}>
              Try again
            </Button>
          )}
        </div>
      </Frame>
    );
  }
  if (!info) return <Frame><Loading label="Loading…" /></Frame>;

  const { scenario, access, branding } = info;
  const showName = access.identityMode !== 'NONE' && !(info.kind === 'invite' && info.participant?.name);
  const nameRequired = access.requiresName;
  const needEmail = info.kind !== 'invite' && (access.requiresEmail || access.allowedEmailDomains.length > 0);
  const missingVars = info.variables.filter((v) => !(v.key in fromUrl) && v.required);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const variables = { ...fromUrl, ...Object.fromEntries(Object.entries(vars).filter(([, v]) => v.trim())) };
      const res = await start({
        name: name.trim() || undefined,
        email: needEmail ? email.trim() : undefined,
        passcode: access.passcodeRequired ? passcode : undefined,
        variables: Object.keys(variables).length ? variables : undefined,
      });
      storeSessionToken(res.sessionId, res.sessionToken);
      router.push(`/live/${res.sessionId}`);
    } catch (err) {
      setSubmitting(false);
      if (err instanceof ApiError) {
        const friendly = FRIENDLY[err.code];
        const field = Array.isArray(err.details) ? ((err.details as any[])[0]?.path as string | undefined) : undefined;
        if (err.status === 410 && friendly) setError({ message: `${friendly.title}. ${friendly.body}`, fatal: true });
        else if (err.code === 'invalid_passcode') setError({ message: 'That passcode is not correct.', field: 'passcode' });
        else if (err.code === 'passcode_required') setError({ message: 'Enter the passcode you received with this link.', field: 'passcode' });
        else if (err.code === 'email_domain_not_allowed') setError({ message: err.message, field: 'email' });
        else if (err.code === 'attempt_limit_reached') setError({ message: `${err.message} Contact the organizer if you need another attempt.`, fatal: true });
        else if (err.code === 'rate_limited') setError({ message: err.message || FRIENDLY.rate_limited!.body });
        else if (err.code === 'quota_exceeded') setError({ message: 'This conversation is temporarily unavailable (usage limit reached). Please contact the organizer.', fatal: true });
        else setError({ message: err.message, field });
      } else {
        setError({ message: err instanceof Error ? err.message : 'Something went wrong' });
      }
    }
  };

  return (
    <Frame branding={branding}>
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-semibold text-slate-900">{scenario.name}</h1>
          {scenario.description && <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{scenario.description}</p>}
          <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-slate-500">
            {scenario.personaName && (
              <div>
                <dt className="inline">With: </dt>
                <dd className="inline font-medium text-slate-700">{scenario.personaName}</dd>
              </div>
            )}
            <div>
              <dt className="inline">About </dt>
              <dd className="inline font-medium text-slate-700">{scenario.durationMinutes} min</dd>
              <span> (max {scenario.maxDurationMinutes})</span>
            </div>
            {(scenario.recording.audio || scenario.recording.video) && (
              <div>
                <dd className="inline">Recorded ({[scenario.recording.audio && 'audio', scenario.recording.video && 'video'].filter(Boolean).join(' + ')}) — you’ll be asked for consent</dd>
              </div>
            )}
          </dl>
        </div>
        {scenario.participantInstructions && (
          <div className="rounded-md bg-slate-50 p-3 text-sm text-slate-700">
            <p className="mb-1 font-medium text-slate-900">Before you start</p>
            <p className="whitespace-pre-line">{scenario.participantInstructions}</p>
          </div>
        )}
        {info.kind === 'invite' && info.participant?.email && (
          <p className="text-sm text-slate-600">
            This is a personal invitation for <span className="font-medium">{info.participant.email}</span>. Please don’t share it.
          </p>
        )}
        {error?.fatal ? (
          <Alert tone="error">{error.message}</Alert>
        ) : (
          <form onSubmit={submit} className="space-y-4" noValidate>
            {error && !error.field && <Alert tone="error">{error.message}</Alert>}
            {showName && (
              <Field label="Your name" required={nameRequired} error={error?.field === 'name' ? error.message : undefined}>
                {(id) => <Input id={id} autoComplete="name" maxLength={120} required={nameRequired} value={name} onChange={(e) => setName(e.target.value)} />}
              </Field>
            )}
            {needEmail && (
              <Field
                label="Email"
                required
                hint={access.allowedEmailDomains.length ? `Use your ${access.allowedEmailDomains.join(' / ')} address.` : access.attemptLimitPerEmail ? `Limited to ${access.attemptLimitPerEmail} attempt(s) per email.` : undefined}
                error={error?.field === 'email' ? error.message : undefined}
              >
                {(id) => <Input id={id} type="email" autoComplete="email" maxLength={254} required value={email} onChange={(e) => setEmail(e.target.value)} />}
              </Field>
            )}
            {access.passcodeRequired && (
              <Field label="Passcode" required error={error?.field === 'passcode' ? error.message : undefined}>
                {(id) => <Input id={id} type="password" autoComplete="off" maxLength={128} required value={passcode} onChange={(e) => setPasscode(e.target.value)} />}
              </Field>
            )}
            {missingVars.map((v) => (
              <Field key={v.key} label={v.label} hint={v.description || undefined} required error={error?.field === `variables.${v.key}` ? error.message : undefined}>
                {(id) => <Input id={id} maxLength={v.maxLength} required value={vars[v.key] ?? ''} onChange={(e) => setVars((s) => ({ ...s, [v.key]: e.target.value }))} />}
              </Field>
            ))}
            <Button type="submit" size="lg" className="w-full" loading={submitting}>
              {submitting ? 'Starting…' : 'Continue'}
            </Button>
            <p className="text-center text-xs text-slate-500">
              Next you’ll check your microphone and review how your conversation is recorded and used.
              {access.oneTime && ' This link can be used once.'}
            </p>
          </form>
        )}
      </div>
    </Frame>
  );
}

function Frame({ children, branding }: { children: React.ReactNode; branding?: LandingInfo['branding'] }) {
  return (
    <main className="flex min-h-screen flex-col items-center bg-slate-50 px-4 py-10" style={brandStyle(branding?.primaryColor)}>
      <div className="w-full max-w-lg">
        {branding && (
          <header className="mb-5 flex items-center justify-center gap-3">
            {branding.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={branding.logoUrl} alt={branding.displayName} className="h-10 max-w-[180px] object-contain" />
            ) : null}
            <span className="text-base font-semibold text-slate-800">{branding.displayName}</span>
          </header>
        )}
        <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">{children}</div>
        <footer className="mt-4 space-y-1 text-center text-xs text-slate-500">
          {branding?.supportEmail && (
            <p>
              Questions? <a className="underline" href={`mailto:${branding.supportEmail}`}>{branding.supportEmail}</a>
            </p>
          )}
          {!branding?.hidePoweredBy && <p>Powered by ConversaForge</p>}
        </footer>
      </div>
    </main>
  );
}

export function LandingFallback() {
  return (
    <main className="flex min-h-screen items-center justify-center">
      <Spinner />
    </main>
  );
}
