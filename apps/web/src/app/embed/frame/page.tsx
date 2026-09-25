'use client';
/**
 * Embeddable call frame (loaded by public/embed.js inside a customer's page).
 *
 * Handshake: we post `frame.ready` to the parent; the host SDK answers with `init` carrying the access
 * token (never in the URL). We only accept `init` from `window.parent`, record the parent's origin from
 * the browser-supplied `event.origin`, check it against the token's allowed origins (and report it to
 * the server, which enforces the same list), create the session, then render the live call.
 * All events we emit go only to that parent origin.
 */
import { Button, Field, Input, Loading } from '@/components/ui';
import { LiveApp } from '@/components/live/LiveApp';
import { LiveShell, StatusScreen } from '@/components/live/Shell';
import { api, ApiError, errorMessage } from '@/lib/api';
import { fetchBootstrap } from '@/lib/live/runtime-api';
import { storeSessionToken } from '@/lib/live/token';
import { isTerminal } from '@cf/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

type InitMsg = {
  source: 'conversaforge-host';
  type: 'init';
  token?: string;
  linkToken?: string;
  participant?: { name?: string; email?: string; externalId?: string };
  variables?: Record<string, string | number | boolean>;
  passcode?: string;
};

type Phase =
  | { k: 'waiting' }
  | { k: 'starting' }
  | { k: 'identity'; needName: boolean; needEmail: boolean; needPasscode: boolean; error?: string }
  | { k: 'live'; sessionId: string; token: string }
  | { k: 'error'; code: string; message: string };

const FRAME = 'conversaforge-frame';

function normOrigin(o: string | null | undefined): string | null {
  if (!o) return null;
  try {
    const u = new URL(o);
    return `${u.protocol}//${u.host}`.toLowerCase();
  } catch {
    return null;
  }
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 32);
}

function cleanVariables(v: unknown): Record<string, string | number | boolean> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>).slice(0, 30)) {
    if (!/^[a-z][a-z0-9_]{0,47}$/.test(k)) continue;
    if (typeof val === 'string') out[k] = val.slice(0, 4000);
    else if (typeof val === 'number' && Number.isFinite(val)) out[k] = val;
    else if (typeof val === 'boolean') out[k] = val;
  }
  return Object.keys(out).length ? out : undefined;
}

export default function EmbedFrame() {
  const [phase, setPhase] = useState<Phase>({ k: 'waiting' });
  const parentOrigin = useRef<string | null>(null);
  const init = useRef<InitMsg | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  const post = useCallback((type: string, data: Record<string, unknown> = {}) => {
    if (!parentOrigin.current || window.parent === window) return;
    window.parent.postMessage({ source: FRAME, type: 'event', name: type, data }, parentOrigin.current);
  }, []);

  const fail = useCallback(
    (code: string, message: string) => {
      setPhase({ k: 'error', code, message });
      post('error', { code, message });
    },
    [post],
  );

  const begin = useCallback(
    async (msg: InitMsg, identity?: { name?: string; email?: string; passcode?: string }) => {
      setPhase({ k: 'starting' });
      const origin = parentOrigin.current!;
      const variables = cleanVariables(msg.variables);
      try {
        // Resume a session this frame already started for the same credentials (frame reload).
        const key = `cf:embed:${await sha256(msg.token ?? `link:${msg.linkToken}`)}`;
        let resumed: { sessionId: string; token: string } | null = null;
        try {
          const saved = JSON.parse(sessionStorage.getItem(key) ?? 'null');
          if (saved?.sessionId && saved?.token) {
            const b = await fetchBootstrap(saved.sessionId, saved.token).catch(() => null);
            if (b && !isTerminal(b.state)) resumed = saved;
          }
        } catch {
          /* storage unavailable */
        }
        if (resumed) {
          storeSessionToken(resumed.sessionId, resumed.token);
          sessionIdRef.current = resumed.sessionId;
          setPhase({ k: 'live', ...resumed });
          post('session.created', { sessionId: resumed.sessionId, resumed: true });
          return;
        }

        let created: { sessionId: string; sessionToken: string; allowedOrigins?: string[] };
        if (msg.token) {
          // Pre-flight: refuse to run on a site the token was not minted for (server enforces too).
          const info: any = await api('/api/public/embed/token-info', { token: msg.token });
          const allowed: string[] = (info?.allowedOrigins ?? []).map((o: string) => normOrigin(o)).filter(Boolean);
          if (allowed.length && !allowed.includes(origin)) return fail('origin_not_allowed', 'This conversation is not allowed on this website.');
          created = await api('/api/public/embed/sessions', { method: 'POST', token: msg.token, body: { parentOrigin: origin, variables } });
          const after = (created.allowedOrigins ?? []).map((o) => normOrigin(o)).filter(Boolean);
          if (after.length && !after.includes(origin)) return fail('origin_not_allowed', 'This conversation is not allowed on this website.');
        } else if (msg.linkToken) {
          const lt = encodeURIComponent(msg.linkToken);
          const landing: any = await api(`/api/public/links/${lt}`);
          const name = identity?.name ?? msg.participant?.name;
          const email = identity?.email ?? msg.participant?.email;
          const passcode = identity?.passcode ?? msg.passcode;
          const needName = !!landing?.access?.requiresName && !name;
          const needEmail = !!landing?.access?.requiresEmail && !email;
          const needPasscode = !!landing?.access?.passcodeRequired && !passcode;
          if (needName || needEmail || needPasscode) {
            setPhase({ k: 'identity', needName, needEmail, needPasscode });
            post('identity.required', { name: needName, email: needEmail, passcode: needPasscode });
            return;
          }
          created = await api(`/api/public/links/${lt}/sessions`, {
            method: 'POST',
            body: { name: name || undefined, email: email || undefined, passcode: passcode || undefined, variables },
          });
        } else {
          return fail('missing_token', 'No access token was provided to the embed.');
        }
        storeSessionToken(created.sessionId, created.sessionToken);
        try {
          sessionStorage.setItem(key, JSON.stringify({ sessionId: created.sessionId, token: created.sessionToken }));
        } catch {
          /* ignore */
        }
        sessionIdRef.current = created.sessionId;
        setPhase({ k: 'live', sessionId: created.sessionId, token: created.sessionToken });
        post('session.created', { sessionId: created.sessionId });
      } catch (e) {
        if (e instanceof ApiError && msg.linkToken && (e.code === 'passcode_invalid' || e.code === 'identity_required' || e.status === 422 || e.code === 'validation_error')) {
          const needPasscode = /passcode/i.test(e.code + e.message);
          setPhase({ k: 'identity', needName: !needPasscode, needEmail: !needPasscode, needPasscode, error: errorMessage(e) });
          return;
        }
        fail(e instanceof ApiError ? e.code : 'start_failed', errorMessage(e));
      }
    },
    [fail, post],
  );

  useEffect(() => {
    const onMessage = (ev: MessageEvent) => {
      if (ev.source !== window.parent || window.parent === window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== 'conversaforge-host') return;
      if (d.type === 'init') {
        if (init.current) return; // one init per frame
        const origin = normOrigin(ev.origin);
        // Where supported, cross-check with the browser's ancestor list.
        const anc = (window.location as any).ancestorOrigins as DOMStringList | undefined;
        if (!origin || (anc && anc.length && normOrigin(anc[0]) !== origin)) return;
        parentOrigin.current = origin;
        init.current = d as InitMsg;
        if (typeof d.token !== 'string' && typeof d.linkToken !== 'string') return fail('missing_token', 'No access token was provided.');
        void begin(d as InitMsg);
      } else if (d.type === 'end' && ev.origin && normOrigin(ev.origin) === parentOrigin.current) {
        window.dispatchEvent(new CustomEvent('cf-live-command', { detail: { type: 'end' } }));
      }
    };
    window.addEventListener('message', onMessage);
    // Announce readiness (no secrets in this message; the parent validates our origin).
    const announce = () => window.parent !== window && window.parent.postMessage({ source: FRAME, type: 'frame.ready', version: 1 }, '*');
    announce();
    const again = setInterval(() => (init.current ? clearInterval(again) : announce()), 1000);
    return () => {
      window.removeEventListener('message', onMessage);
      clearInterval(again);
    };
  }, [begin, fail]);

  // Report content height so the host can size the iframe (autoHeight).
  useEffect(() => {
    if (!parentOrigin.current && phase.k === 'waiting') return;
    const ro = new ResizeObserver(() => {
      if (parentOrigin.current) window.parent.postMessage({ source: FRAME, type: 'resize', height: document.documentElement.scrollHeight }, parentOrigin.current);
    });
    ro.observe(document.body);
    return () => ro.disconnect();
  }, [phase.k]);

  if (typeof window !== 'undefined' && window.parent === window && phase.k === 'waiting') {
    return (
      <LiveShell compact>
        <StatusScreen title="Embed frame">
          <p>This page is meant to be embedded with the ConversaForge embed script. See the embed documentation.</p>
        </StatusScreen>
      </LiveShell>
    );
  }

  if (phase.k === 'live') {
    return (
      <LiveApp
        sessionId={phase.sessionId}
        token={phase.token}
        compact
        onLifecycle={(e) => {
          if (e.type === 'loaded') post('ready', { sessionId: phase.sessionId, state: e.data.state });
          else if (e.type === 'session.ended') post('session.ended', { sessionId: phase.sessionId, ...e.data });
          else post(e.type, { sessionId: phase.sessionId, ...e.data });
        }}
      />
    );
  }

  return (
    <LiveShell compact>
      {(phase.k === 'waiting' || phase.k === 'starting') && <Loading label={phase.k === 'waiting' ? 'Connecting…' : 'Starting your conversation…'} />}
      {phase.k === 'error' && (
        <StatusScreen title="This conversation can’t start" tone="error">
          <p>{phase.message}</p>
        </StatusScreen>
      )}
      {phase.k === 'identity' && init.current && <IdentityForm phase={phase} onSubmit={(id) => void begin(init.current!, id)} />}
    </LiveShell>
  );
}

function IdentityForm({
  phase,
  onSubmit,
}: {
  phase: Extract<Phase, { k: 'identity' }>;
  onSubmit: (v: { name?: string; email?: string; passcode?: string }) => void;
}) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [passcode, setPasscode] = useState('');
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit({ name: name || undefined, email: email || undefined, passcode: passcode || undefined });
      }}
    >
      <h1 className="text-base font-semibold text-slate-900">A few details before you start</h1>
      {phase.error && (
        <p className="text-sm text-red-700" role="alert">
          {phase.error}
        </p>
      )}
      {phase.needName && <Field label="Your name" required>{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} autoComplete="name" />}</Field>}
      {phase.needEmail && (
        <Field label="Your email" required>
          {(id) => <Input id={id} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254} autoComplete="email" />}
        </Field>
      )}
      {phase.needPasscode && (
        <Field label="Passcode" required>
          {(id) => <Input id={id} value={passcode} onChange={(e) => setPasscode(e.target.value)} required maxLength={128} autoComplete="off" />}
        </Field>
      )}
      <Button type="submit">Continue</Button>
    </form>
  );
}
