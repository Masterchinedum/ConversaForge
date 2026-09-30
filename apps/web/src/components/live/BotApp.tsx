'use client';
/**
 * Meeting agent bot page (Recall.ai output media). Recall's bot browser opens `/bot/<id>#t=<token>`:
 * - getUserMedia returns the meeting's audio (the bot grants the permission itself),
 * - whatever this page plays is the bot's microphone, and what it renders is the bot's camera (1280×720).
 * So the page runs the normal live call (useLiveCall) with no screens to click through. It waits until
 * someone in the meeting speaks before starting, so the persona doesn't greet an empty lobby.
 */
import { stopStream, createAudioContext } from '@/lib/live/devices';
import { fetchBootstrap, type LiveBootstrap } from '@/lib/live/runtime-api';
import { transcriptRows } from '@/lib/live/store';
import { readSessionToken } from '@/lib/live/token';
import { useLiveCall, type CallDevices } from '@/lib/live/use-live-call';
import { errorMessage } from '@/lib/api';
import { isTerminal, LIVE_STATES, type SessionState } from '@cf/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { brandStyle } from './branding';

type Phase =
  | { k: 'loading' }
  | { k: 'error'; message: string }
  | { k: 'waiting' }
  | { k: 'call' }
  | { k: 'ended'; state: SessionState | null };

/** RMS level (0..1) the meeting audio must exceed, and for how long, to count as someone speaking. */
const SPEECH_RMS = 0.02;
const SPEECH_HOLD_MS = 300;

export function BotApp({ sessionId }: { sessionId: string }) {
  const [phase, setPhase] = useState<Phase>({ k: 'loading' });
  const [boot, setBoot] = useState<LiveBootstrap | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [devices, setDevices] = useState<CallDevices | null>(null);
  const devicesRef = useRef<CallDevices | null>(null);
  devicesRef.current = devices;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const t = readSessionToken(sessionId);
      if (!t) return setPhase({ k: 'error', message: 'This bot page needs its session link.' });
      setToken(t);
      try {
        const b = await fetchBootstrap(sessionId, t);
        if (cancelled) return;
        setBoot(b);
        if (isTerminal(b.state)) return setPhase({ k: 'ended', state: b.state });
        const d = await meetingDevices().catch((e) => {
          throw new Error(`Could not hear the meeting (${(e as Error)?.message || 'no audio input'}). This page only works inside the meeting bot.`);
        });
        if (cancelled) return release(d);
        setDevices(d);
        // Page reloaded mid-call: rejoin at once instead of waiting for speech.
        const live = (LIVE_STATES as readonly string[]).includes(b.state) || b.state === 'CONNECTING';
        setPhase(live ? { k: 'call' } : { k: 'waiting' });
      } catch (e) {
        if (!cancelled) setPhase({ k: 'error', message: errorMessage(e) });
      }
    })();
    return () => {
      cancelled = true;
      release(devicesRef.current);
    };
  }, [sessionId]);

  // Waiting in the meeting: start once somebody talks.
  useEffect(() => {
    if (phase.k !== 'waiting' || !devices?.micStream || !devices.audioContext) return;
    return onSpeech(devices.audioContext, devices.micStream, () => setPhase({ k: 'call' }));
  }, [phase.k, devices]);

  const persona = boot?.config.persona;
  return (
    <div style={brandStyle(boot?.branding?.primaryColor)} className="flex h-[100dvh] w-full flex-col items-center justify-center bg-slate-900 px-8 text-center text-white">
      {phase.k === 'loading' && <Status>Getting ready…</Status>}
      {phase.k === 'error' && <Status>{phase.message}</Status>}
      {boot && persona && phase.k === 'waiting' && (
        <Stage persona={persona} name={persona.name} role={persona.role} speaking={false}>
          <Status>Say hello to start the practice session</Status>
        </Stage>
      )}
      {boot && token && devices && phase.k === 'call' && (
        <BotCall boot={boot} token={token} devices={devices} onEnded={(state) => setPhase({ k: 'ended', state })} />
      )}
      {boot && persona && phase.k === 'ended' && (
        <Stage persona={persona} name={persona.name} role={persona.role} speaking={false}>
          <Status>{phase.state === 'FAILED' ? 'The session stopped because of a problem.' : 'Practice session ended. Your feedback will be ready shortly.'}</Status>
        </Stage>
      )}
    </div>
  );
}

function BotCall({ boot, token, devices, onEnded }: { boot: LiveBootstrap; token: string; devices: CallDevices; onEnded: (s: SessionState | null) => void }) {
  const call = useLiveCall({ sessionId: boot.sessionId, token, config: boot.config, devices, consent: boot.consent.given });
  const { state } = call;
  const persona = boot.config.persona;
  const rows = useMemo(() => transcriptRows(state), [state]);
  const caption = [...rows].reverse().find((r) => r.speaker === 'AGENT')?.text ?? '';

  const ended = (state.state && isTerminal(state.state)) || !!state.end || state.fatal?.kind === 'terminal';
  useEffect(() => {
    if (!ended) return;
    const t = setTimeout(() => onEnded(state.state), call.agentSpeaking ? 1500 : 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ended]);

  const status = state.fatal && state.fatal.kind !== 'terminal'
    ? state.fatal.message
    : state.conn !== 'open'
      ? 'Reconnecting…'
      : call.agentSpeaking
        ? null
        : call.thinking
          ? 'Thinking…'
          : 'Listening';
  return (
    <Stage persona={persona} name={persona.name} role={persona.role} speaking={call.agentSpeaking}>
      {caption && <p className="mx-auto mt-6 line-clamp-3 max-w-3xl text-2xl leading-snug text-slate-100">{caption}</p>}
      {status && <p className="mt-4 text-base text-slate-400">{status}</p>}
    </Stage>
  );
}

function Stage({ persona, name, role, speaking, children }: { persona: LiveBootstrap['persona']; name: string; role: string; speaking: boolean; children?: ReactNode }) {
  return (
    <div className="flex w-full flex-col items-center">
      <div className="scale-150">
        <AgentAvatar persona={persona} speaking={speaking} size="lg" />
      </div>
      <h1 className="mt-10 text-3xl font-semibold">{name || 'AI agent'}</h1>
      {role && <p className="mt-1 text-lg text-slate-300">{role}</p>}
      {children}
    </div>
  );
}

function Status({ children }: { children: ReactNode }) {
  return <p className="mt-6 text-xl text-slate-300">{children}</p>;
}

/**
 * The meeting audio. Browser echo cancellation / noise suppression would treat the bot's own output as
 * echo and distort the meeting audio, and the meeting platform has already processed it.
 */
async function meetingDevices(): Promise<CallDevices> {
  const micStream = await navigator.mediaDevices
    .getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }, video: false })
    .catch(() => navigator.mediaDevices.getUserMedia({ audio: true, video: false }));
  const audioContext = createAudioContext();
  // No user gesture is possible in the bot browser; try anyway (the bot browser allows autoplay).
  await audioContext?.resume().catch(() => undefined);
  return { micStream, cameraStream: null, audioContext, preferTyped: false };
}

function release(d: CallDevices | null) {
  stopStream(d?.micStream);
  void d?.audioContext?.close().catch(() => undefined);
}

/** Call `fire` once the stream's level stays above SPEECH_RMS for SPEECH_HOLD_MS. Returns a cleanup. */
function onSpeech(ctx: AudioContext, stream: MediaStream, fire: () => void): () => void {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let loudSince: number | null = null;
  let done = false;
  const timer = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (rms < SPEECH_RMS) loudSince = null;
    else if (loudSince === null) loudSince = now;
    else if (!done && now - loudSince >= SPEECH_HOLD_MS) {
      done = true;
      fire();
    }
  }, 50);
  return () => {
    clearInterval(timer);
    src.disconnect();
  };
}
