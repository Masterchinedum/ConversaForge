'use client';
import { Alert, Button, clsx, Select } from '@/components/ui';
import {
  acquireCamera,
  acquireMic,
  classifyMediaError,
  createAudioContext,
  listDevices,
  loadDevicePrefs,
  playTestTone,
  saveDevicePrefs,
  setOutputDevice,
  stopStream,
} from '@/lib/live/devices';
import type { LiveBootstrap } from '@/lib/live/runtime-api';
import type { CallDevices } from '@/lib/live/use-live-call';
import { detectCapabilities, planVoice, VOICE_MODE_LABELS, type BrowserCapabilities } from '@/lib/voice';
import { hasSpeechSynthesis, pickVoice } from '@/lib/voice/synth';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { MicMeter, useStreamLevel } from './MicMeter';

type Step = 'explain' | 'requesting' | 'ready' | 'error';

export function DeviceCheck({
  boot,
  wantCamera,
  onReady,
  onBack,
  resume,
}: {
  boot: LiveBootstrap;
  wantCamera: boolean;
  onReady: (d: CallDevices) => void;
  onBack?: () => void;
  /** Rejoining after a refresh: shorter copy. */
  resume?: boolean;
}) {
  const { config } = boot;
  const [step, setStep] = useState<Step>('explain');
  const [error, setError] = useState<string | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [mic, setMic] = useState<MediaStream | null>(null);
  const [cam, setCam] = useState<MediaStream | null>(null);
  const [ctx, setCtx] = useState<AudioContext | null>(null);
  const [devices, setDevices] = useState<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }>({ mics: [], cams: [], speakers: [] });
  const [prefs, setPrefs] = useState(loadDevicePrefs);
  const [testing, setTesting] = useState(false);
  const [heard, setHeard] = useState<boolean | null>(null);
  const [caps, setCaps] = useState<BrowserCapabilities | null>(null);
  const handedOff = useRef(false);
  const micRef = useRef<MediaStream | null>(null);
  const camRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const subscribe = useStreamLevel(mic, ctx);
  const ids = { mic: useId(), cam: useId(), spk: useId() };

  useEffect(() => setCaps(detectCapabilities()), []);
  useEffect(() => {
    micRef.current = mic;
    camRef.current = cam;
    ctxRef.current = ctx;
  }, [mic, cam, ctx]);
  // Release devices if the participant leaves this screen without joining.
  useEffect(
    () => () => {
      if (handedOff.current) return;
      stopStream(micRef.current);
      stopStream(camRef.current);
      void ctxRef.current?.close().catch(() => undefined);
    },
    [],
  );
  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = cam;
  }, [cam]);

  const plan = useMemo(
    () => (caps ? planVoice(config, caps, { hasMic: !!mic }) : null),
    [caps, config, mic],
  );

  const ensureCtx = () => {
    let c = ctxRef.current;
    if (!c) {
      c = createAudioContext();
      ctxRef.current = c;
      setCtx(c);
    }
    void c?.resume().catch(() => undefined);
    return c;
  };

  const request = async (micId = prefs.mic, camId = prefs.cam) => {
    setStep('requesting');
    setError(null);
    ensureCtx();
    try {
      stopStream(micRef.current);
      const m = await acquireMic(micId, config.audio).catch(async (e) => {
        // A remembered device may be gone: retry with the default one.
        if (micId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) return acquireMic(undefined, config.audio);
        throw e;
      });
      micRef.current = m;
      setMic(m);
      if (wantCamera) {
        try {
          stopStream(camRef.current);
          const c = await acquireCamera(camId).catch(async (e) => {
            if (camId && (e?.name === 'OverconstrainedError' || e?.name === 'NotFoundError')) return acquireCamera(undefined);
            throw e;
          });
          camRef.current = c;
          setCam(c);
          setCamError(null);
        } catch (e) {
          setCamError(`${classifyMediaError(e, 'camera').message} You can continue without the camera.`);
        }
      }
      setDevices(await listDevices());
      setStep('ready');
    } catch (e) {
      setError(classifyMediaError(e, 'microphone').message);
      setStep('error');
    }
  };

  const changeMic = async (id: string) => {
    const p = { ...prefs, mic: id };
    setPrefs(p);
    saveDevicePrefs(p);
    try {
      const m = await acquireMic(id, config.audio);
      stopStream(micRef.current);
      micRef.current = m;
      setMic(m);
    } catch (e) {
      setError(classifyMediaError(e).message);
    }
  };

  const changeCam = async (id: string) => {
    const p = { ...prefs, cam: id };
    setPrefs(p);
    saveDevicePrefs(p);
    try {
      const c = await acquireCamera(id);
      stopStream(camRef.current);
      camRef.current = c;
      setCam(c);
      setCamError(null);
    } catch (e) {
      setCamError(classifyMediaError(e, 'camera').message);
    }
  };

  const changeSpeaker = async (id: string) => {
    const p = { ...prefs, speaker: id };
    setPrefs(p);
    saveDevicePrefs(p);
    const c = ensureCtx();
    if (c) await setOutputDevice(c, id);
  };

  const testSpeaker = async () => {
    setTesting(true);
    setHeard(null);
    try {
      const c = ensureCtx();
      if (plan?.output === 'browser' && hasSpeechSynthesis()) {
        await new Promise<void>((resolve) => {
          const u = new SpeechSynthesisUtterance(`Hi! This is how I will sound.`);
          u.lang = config.language;
          const v = pickVoice(window.speechSynthesis.getVoices(), config.language, config.voice.voiceId);
          if (v) u.voice = v;
          u.rate = config.voice.speed || 1;
          u.onend = () => resolve();
          u.onerror = () => resolve();
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(u);
          setTimeout(resolve, 5000);
        });
      } else if (c) {
        await playTestTone(c);
      }
    } finally {
      setTesting(false);
    }
  };

  const join = (typed: boolean) => {
    handedOff.current = true;
    const c = ensureCtx();
    if (typed) {
      // Typing by choice: release the mic/camera (nothing is captured or recorded).
      stopStream(micRef.current);
      stopStream(camRef.current);
      onReady({ micStream: null, cameraStream: null, audioContext: c, preferTyped: true });
      return;
    }
    onReady({ micStream: mic, cameraStream: cam, audioContext: c, preferTyped: typed });
  };

  const canSetSink = typeof (globalThis as any).AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{resume ? 'Rejoin your conversation' : 'Check your microphone'}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {resume
            ? 'Your conversation is still in progress. Reconnect your microphone to continue where you left off.'
            : 'We’ll ask your browser for access to your microphone' +
              (wantCamera ? ' and camera' : '') +
              '. They are only used during this conversation, and you can mute at any time.'}
        </p>
      </div>

      {step === 'explain' && (
        <div className="space-y-3">
          <Alert tone="info">
            When your browser asks, choose <strong>Allow</strong>. If you previously blocked access, use the lock icon in the
            address bar to allow it.
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-between">
            {onBack ? (
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              {config.ui.allowTextFallback && (
                <Button variant="secondary" onClick={() => join(true)}>
                  Type instead
                </Button>
              )}
              <Button size="lg" onClick={() => request()}>
                Allow microphone{wantCamera ? ' & camera' : ''}
              </Button>
            </div>
          </div>
        </div>
      )}

      {step === 'requesting' && (
        <p className="text-sm text-slate-600" role="status">
          Waiting for permission…
        </p>
      )}

      {step === 'error' && (
        <div className="space-y-3">
          <Alert tone="error" title="We couldn’t use your microphone">
            {error}
          </Alert>
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
            {config.ui.allowTextFallback && (
              <Button variant="secondary" onClick={() => join(true)}>
                Continue by typing
              </Button>
            )}
            <Button onClick={() => request()}>Try again</Button>
          </div>
        </div>
      )}

      {step === 'ready' && (
        <div className="space-y-5">
          <div className="space-y-2">
            <label htmlFor={ids.mic} className="block text-sm font-medium text-slate-700">
              Microphone
            </label>
            {devices.mics.length > 1 && (
              <Select id={ids.mic} value={mic?.getAudioTracks()[0]?.getSettings().deviceId ?? prefs.mic ?? ''} onChange={(e) => void changeMic(e.target.value)}>
                {devices.mics.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Microphone ${i + 1}`}
                  </option>
                ))}
              </Select>
            )}
            <MicMeter subscribe={subscribe} />
            <p className="text-xs text-slate-500">Say something — the bar should move.</p>
          </div>

          <div className="space-y-2">
            <p className="text-sm font-medium text-slate-700" id={ids.spk + '-l'}>
              Speaker
            </p>
            {canSetSink && devices.speakers.length > 1 && (
              <Select aria-labelledby={ids.spk + '-l'} value={prefs.speaker ?? 'default'} onChange={(e) => void changeSpeaker(e.target.value)}>
                {devices.speakers.map((d, i) => (
                  <option key={d.deviceId || i} value={d.deviceId}>
                    {d.label || `Speaker ${i + 1}`}
                  </option>
                ))}
              </Select>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" size="sm" onClick={testSpeaker} loading={testing}>
                ▶ Play test sound
              </Button>
              {heard === null && !testing && (
                <span className="flex items-center gap-2 text-xs text-slate-600">
                  Heard it?
                  <button className="rounded px-1.5 py-0.5 underline focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setHeard(true)}>
                    Yes
                  </button>
                  <button className="rounded px-1.5 py-0.5 underline focus-visible:ring-2 focus-visible:ring-brand-500" onClick={() => setHeard(false)}>
                    No
                  </button>
                </span>
              )}
            </div>
            {heard === false && (
              <p className="text-xs text-amber-800" role="status">
                Check your volume, headphones and output device. The agent’s replies are also shown as captions.
              </p>
            )}
          </div>

          {wantCamera && (
            <div className="space-y-2">
              <label htmlFor={ids.cam} className="block text-sm font-medium text-slate-700">
                Camera
              </label>
              {devices.cams.length > 1 && (
                <Select id={ids.cam} value={cam?.getVideoTracks()[0]?.getSettings().deviceId ?? prefs.cam ?? ''} onChange={(e) => void changeCam(e.target.value)}>
                  {devices.cams.map((d, i) => (
                    <option key={d.deviceId || i} value={d.deviceId}>
                      {d.label || `Camera ${i + 1}`}
                    </option>
                  ))}
                </Select>
              )}
              {cam ? (
                <video ref={videoRef} autoPlay muted playsInline className="aspect-video w-full max-w-sm rounded-lg bg-slate-900 object-cover" aria-label="Camera preview" />
              ) : (
                camError && <Alert tone="warning">{camError}</Alert>
              )}
            </div>
          )}

          {caps && plan && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-medium text-slate-800">
                Voice mode: <span data-testid="planned-voice-mode">{VOICE_MODE_LABELS[plan.mode]}</span>
              </p>
              {plan.reason && <p className="mt-1 text-slate-600">{plan.reason}</p>}
              <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-slate-600">
                <Cap ok={caps.speechRecognition} label="Speech recognition" />
                <Cap ok={caps.speechSynthesis} label="Speech synthesis" />
                <Cap ok={caps.mediaRecorder} label="Recording" />
                <Cap ok={caps.webrtc} label="WebRTC" />
              </ul>
            </div>
          )}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {onBack ? (
              <Button variant="ghost" onClick={onBack}>
                Back
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-col gap-2 sm:flex-row">
              {config.ui.allowTextFallback && plan?.mode !== 'typed' && (
                <Button variant="secondary" onClick={() => join(true)}>
                  Type instead
                </Button>
              )}
              <Button size="lg" onClick={() => join(false)}>
                {resume ? 'Rejoin call' : 'Join the call'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Cap({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className={clsx('flex items-center gap-1', ok ? 'text-emerald-700' : 'text-slate-500')}>
      <span aria-hidden>{ok ? '✓' : '✕'}</span>
      {label}
      <span className="sr-only">{ok ? 'available' : 'not available'}</span>
    </li>
  );
}
