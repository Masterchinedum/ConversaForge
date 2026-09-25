'use client';
import { Button, Loading } from '@/components/ui';
import { ApiError, errorMessage } from '@/lib/api';
import { stopStream } from '@/lib/live/devices';
import { fetchBootstrap, type ConsentChoice, type LiveBootstrap } from '@/lib/live/runtime-api';
import { readSessionToken } from '@/lib/live/token';
import type { CallDevices, LifecycleEvent } from '@/lib/live/use-live-call';
import { detectCapabilities, planVoice } from '@/lib/voice';
import { isTerminal, LIVE_STATES, type SessionState } from '@cf/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CallScreen, type CallEnded } from './CallScreen';
import { ConsentScreen } from './ConsentScreen';
import { DeviceCheck } from './DeviceCheck';
import { EndScreen } from './EndScreen';
import { IntroScreen } from './IntroScreen';
import { LiveShell, StatusScreen } from './Shell';

type Phase =
  | { k: 'loading' }
  | { k: 'no_token' }
  | { k: 'error'; title: string; message: string; retry: boolean }
  | { k: 'intro' }
  | { k: 'consent' }
  | { k: 'devices'; resume: boolean }
  | { k: 'call' }
  | { k: 'ended'; state: SessionState | null; reason: string | null; durationMs: number | null };

export function LiveApp({
  sessionId,
  token: tokenProp,
  returnUrl,
  compact,
  onLifecycle,
}: {
  sessionId: string;
  token?: string | null;
  returnUrl?: string | null;
  compact?: boolean;
  onLifecycle?: (e: LifecycleEvent | { type: 'loaded'; data: Record<string, unknown> }) => void;
}) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [boot, setBoot] = useState<LiveBootstrap | null>(null);
  const [token, setToken] = useState<string | null>(tokenProp ?? null);
  const [consent, setConsent] = useState<ConsentChoice | null>(null);
  const [devices, setDevices] = useState<CallDevices | null>(null);
  const devicesRef = useRef<CallDevices | null>(null);
  devicesRef.current = devices;
  const lifecycle = useRef(onLifecycle);
  lifecycle.current = onLifecycle;

  const load = useCallback(async () => {
    const t = tokenProp ?? readSessionToken(sessionId);
    if (!t) {
      setPhase({ k: 'no_token' });
      return;
    }
    setToken(t);
    setPhase({ k: 'loading' });
    try {
      const b = await fetchBootstrap(sessionId, t);
      setBoot(b);
      if (typeof document !== 'undefined' && !compact) document.title = `${b.scenario.name} · Conversation`;
      lifecycle.current?.({ type: 'loaded', data: { state: b.state } });
      if (b.consent.given) setConsent(b.consent.given);
      if (isTerminal(b.state)) {
        setPhase({ k: 'ended', state: b.state, reason: b.endReason, durationMs: b.durationMs });
      } else if ((LIVE_STATES as readonly string[]).includes(b.state) || b.state === 'CONNECTING') {
        setPhase({ k: 'devices', resume: true });
      } else {
        setPhase({ k: 'intro' });
      }
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        setPhase({
          k: 'error',
          title: 'This link is not valid',
          message: 'The session link is invalid or has expired. Please open the original invitation link again, or ask the organizer for a new one.',
          retry: false,
        });
      } else if (e instanceof ApiError && e.status === 404) {
        setPhase({ k: 'error', title: 'Session not found', message: 'We couldn’t find this session. It may have been deleted.', retry: false });
      } else {
        setPhase({ k: 'error', title: 'We couldn’t load the session', message: errorMessage(e), retry: true });
      }
    }
  }, [sessionId, tokenProp, compact]);

  useEffect(() => {
    void load();
  }, [load]);

  // Release devices when leaving the page.
  useEffect(
    () => () => {
      const d = devicesRef.current;
      stopStream(d?.micStream);
      stopStream(d?.cameraStream);
      void d?.audioContext?.close().catch(() => undefined);
    },
    [],
  );

  const onEnded = useCallback(
    async (e: CallEnded) => {
      const d = devicesRef.current;
      stopStream(d?.micStream);
      stopStream(d?.cameraStream);
      void d?.audioContext?.close().catch(() => undefined);
      setDevices(null);
      if (e.fatal) {
        setPhase({
          k: 'error',
          title: e.fatal.kind === 'auth' ? 'This link is not valid' : 'Connection problem',
          message: e.fatal.message,
          retry: e.fatal.kind !== 'auth',
        });
        return;
      }
      let state = e.state && isTerminal(e.state) ? e.state : 'COMPLETED';
      let durationMs: number | null = e.elapsedMs || null;
      let reason = e.reason;
      // Refresh final state/duration (best effort).
      if (token) {
        try {
          const b = await fetchBootstrap(sessionId, token);
          setBoot(b);
          if (isTerminal(b.state)) state = b.state;
          durationMs = b.durationMs ?? durationMs;
          reason = b.endReason ?? reason;
        } catch {
          /* keep local values */
        }
      }
      setPhase({ k: 'ended', state, reason, durationMs });
    },
    [sessionId, token],
  );

  const wantCamera = !!boot && (boot.config.audio.allowCamera || (boot.config.recording.video && !!consent?.recordVideo));
  const browserSpeechLikely = (() => {
    if (!boot || typeof window === 'undefined') return false;
    const plan = planVoice(boot.config, detectCapabilities(), { hasMic: true });
    return plan.mode === 'browser';
  })();

  const wide = phase.k === 'call';
  return (
    <LiveShell branding={boot?.branding} compact={compact} wide={wide}>
      {phase.k === 'loading' && <Loading label="Loading your session…" />}
      {phase.k === 'no_token' && (
        <StatusScreen title="Missing session link" tone="error">
          <p>
            This page needs the private link you received to start or rejoin the conversation. Open the link from your
            invitation (or the course page) again in this browser.
          </p>
        </StatusScreen>
      )}
      {phase.k === 'error' && (
        <StatusScreen
          title={phase.title}
          tone="error"
          actions={phase.retry ? <Button onClick={() => void load()}>Try again</Button> : undefined}
        >
          <p>{phase.message}</p>
        </StatusScreen>
      )}
      {boot && token && phase.k === 'intro' && (
        <IntroScreen
          boot={boot}
          onContinue={() => setPhase(boot.consent.required && !boot.consent.given ? { k: 'consent' } : { k: 'devices', resume: false })}
        />
      )}
      {boot && token && phase.k === 'consent' && (
        <ConsentScreen
          boot={boot}
          token={token}
          browserSpeech={browserSpeechLikely}
          onBack={() => setPhase({ k: 'intro' })}
          onDone={async (c) => {
            setConsent(c);
            // The runtime config reflects consent (e.g. recording flags), so reload it.
            const fresh = await fetchBootstrap(sessionId, token).catch(() => null);
            setBoot(fresh ? { ...fresh, consent: { ...fresh.consent, given: fresh.consent.given ?? c } } : { ...boot, consent: { ...boot.consent, given: c } });
            setPhase({ k: 'devices', resume: false });
          }}
        />
      )}
      {boot && token && phase.k === 'devices' && (
        <DeviceCheck
          boot={boot}
          wantCamera={wantCamera}
          resume={phase.resume}
          onBack={phase.resume ? undefined : () => setPhase({ k: 'intro' })}
          onReady={(d) => {
            setDevices(d);
            setPhase({ k: 'call' });
          }}
        />
      )}
      {boot && token && devices && phase.k === 'call' && (
        <CallScreen
          boot={boot}
          token={token}
          devices={devices}
          consent={consent ?? boot.consent.given}
          compact={compact}
          onEnded={onEnded}
          onLifecycle={(e) => lifecycle.current?.(e)}
        />
      )}
      {phase.k === 'ended' && (
        <EndScreen
          sessionId={sessionId}
          state={phase.state}
          reason={phase.reason}
          durationMs={phase.durationMs}
          showFeedbackLink={!!boot?.participantCanSeeFeedback && (consent ?? boot?.consent.given)?.analysis !== false}
          returnUrl={returnUrl}
          embedded={compact}
        />
      )}
    </LiveShell>
  );
}
