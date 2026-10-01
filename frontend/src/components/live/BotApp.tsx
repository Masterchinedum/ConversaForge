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
import { api, errorMessage } from '@/lib/api';
import { isTerminal, LIVE_STATES, type SessionState } from '@/shared';
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
const SPEECH_RMS = 0.01;
const SPEECH_HOLD_MS = 300;
/** After Recall reports the bot in the call, give the meeting audio a moment before the persona greets. */
const ADMITTED_GREET_DELAY_MS = 1500;

type BotStatus = { status: string | null; recallStatus: string | null };

function diag(sessionId: string, token: string, event: string, data: Record<string, unknown> = {}) {
  void api(`/channels/meeting-bots/session/${encodeURIComponent(sessionId)}/diagnostics`, { method: 'POST', token, body: { event, data } }).catch(() => undefined);
}

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
          diag(sessionId, t, 'no_audio', { message: String((e as Error)?.message ?? e) });
          throw new Error(`Could not hear the meeting (${(e as Error)?.message || 'no audio input'}). This page only works inside the meeting bot.`);
        });
        if (cancelled) return release(d);
        const track = d.micStream?.getAudioTracks()[0];
        const st = track?.getSettings();
        diag(sessionId, t, 'loaded', {
          audioContext: d.audioContext?.state ?? 'none',
          sampleRate: d.audioContext?.sampleRate ?? 0,
          trackLabel: track?.label ?? '',
          trackMuted: track?.muted ?? null,
          channelCount: st?.channelCount ?? null,
          echoCancellation: st?.echoCancellation ?? null,
        });
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

  // Waiting in the meeting: start once the bot is admitted (the persona greets) or somebody talks.
  const [bot, setBot] = useState<BotStatus | null>(null);
  const startCall = (trigger: string, extra: Record<string, unknown> = {}) => {
    if (token) diag(sessionId, token, 'start', { trigger, ...extra });
    setPhase((p) => (p.k === 'waiting' ? { k: 'call' } : p));
  };
  useEffect(() => {
    if (phase.k !== 'waiting' || !devices?.micStream || !devices.audioContext) return;
    return onSpeech(devices.audioContext, devices.micStream, (rms) => startCall('speech', { rms }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k, devices]);
  useEffect(() => {
    if (phase.k !== 'waiting' || !token) return;
    let stop = false;
    let greetTimer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const s = await api<BotStatus>(`/channels/meeting-bots/session/${encodeURIComponent(sessionId)}/status`, { token }).catch(() => null);
      if (stop || !s) return;
      setBot(s);
      if (s.status === 'IN_CALL' && !greetTimer) greetTimer = setTimeout(() => startCall('admitted', { recallStatus: s.recallStatus }), ADMITTED_GREET_DELAY_MS);
      if (s.status && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(s.status)) setPhase({ k: 'ended', state: null });
    };
    void tick();
    const t = setInterval(() => void tick(), 3000);
    return () => {
      stop = true;
      clearInterval(t);
      if (greetTimer) clearTimeout(greetTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase.k, token, sessionId]);

  // What the page hears, every 5 s while waiting and every 10 s in the call (capped server-side).
  useEffect(() => {
    if (!devices?.micStream || !devices.audioContext || !token || (phase.k !== 'waiting' && phase.k !== 'call')) return;
    return levelReporter(devices.audioContext, devices.micStream, phase.k === 'waiting' ? 5000 : 10000, (peak, avg) => {
      const ctx = devices.audioContext!;
      if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
      diag(sessionId, token, 'level', { phase: phase.k, peak, avg, audioContext: ctx.state });
    });
  }, [phase.k, devices, token, sessionId]);

  const persona = boot?.config.persona;
  return (
    <div style={brandStyle(boot?.branding?.primaryColor)} className="flex h-[100dvh] w-full flex-col items-center justify-center bg-slate-900 px-8 text-center text-white">
      {phase.k === 'loading' && <Status>Getting ready…</Status>}
      {phase.k === 'error' && <Status>{phase.message}</Status>}
      {boot && persona && phase.k === 'waiting' && (
        <Stage persona={persona} name={persona.name} role={persona.role} speaking={false}>
          <Status>
            {bot?.status === 'JOINING' || bot?.status === 'SCHEDULED'
              ? 'Waiting to be let into the meeting…'
              : bot?.status === 'IN_CALL'
                ? 'Joining the conversation…'
                : 'Say hello to start the practice session'}
          </Status>
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

/** Report the peak and average RMS of the meeting audio every `everyMs`. Returns a cleanup. */
function levelReporter(ctx: AudioContext, stream: MediaStream, everyMs: number, report: (peak: number, avg: number) => void): () => void {
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  src.connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  let peak = 0;
  let sum = 0;
  let n = 0;
  const sample = setInterval(() => {
    analyser.getFloatTimeDomainData(buf);
    let s = 0;
    for (const v of buf) s += v * v;
    const rms = Math.sqrt(s / buf.length);
    peak = Math.max(peak, rms);
    sum += rms;
    n += 1;
  }, 100);
  const flush = setInterval(() => {
    report(peak, n ? sum / n : 0);
    peak = 0;
    sum = 0;
    n = 0;
  }, everyMs);
  return () => {
    clearInterval(sample);
    clearInterval(flush);
    src.disconnect();
  };
}

/** Call `fire` once the stream's level stays above SPEECH_RMS for SPEECH_HOLD_MS. Returns a cleanup. */
function onSpeech(ctx: AudioContext, stream: MediaStream, fire: (rms: number) => void): () => void {
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
      fire(Math.round(rms * 10000) / 10000);
    }
  }, 50);
  return () => {
    clearInterval(timer);
    src.disconnect();
  };
}
