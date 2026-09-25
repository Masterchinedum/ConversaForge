/** Media device helpers for the device check (permissions, errors, enumeration, test tone). */

export type MediaErrorKind = 'denied' | 'no_device' | 'in_use' | 'insecure' | 'unsupported' | 'unknown';

export function classifyMediaError(e: unknown, what: 'microphone' | 'camera' = 'microphone'): { kind: MediaErrorKind; message: string } {
  if (typeof window !== 'undefined' && !window.isSecureContext) {
    return {
      kind: 'insecure',
      message: `Your browser only allows ${what} access on secure (https://) pages. Open this link over https, or ask the organizer for a secure link.`,
    };
  }
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    return { kind: 'unsupported', message: `This browser cannot access a ${what}. Try a recent Chrome, Edge, Firefox or Safari.` };
  }
  const name = (e as any)?.name ?? '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        kind: 'denied',
        message: `${what === 'microphone' ? 'Microphone' : 'Camera'} access was blocked. Click the lock or camera icon in the address bar, allow access for this site, then press “Try again”. On a phone, check the browser’s site settings.`,
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { kind: 'no_device', message: `No ${what} was found. Plug one in (or pick another device) and press “Try again”.` };
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return {
        kind: 'in_use',
        message: `Your ${what} is in use by another app or tab (e.g. a video call). Close it and press “Try again”.`,
      };
    default:
      return { kind: 'unknown', message: `We could not start your ${what}${(e as any)?.message ? ` (${(e as any).message})` : ''}.` };
  }
}

export interface AudioProcessing {
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
}

export async function acquireMic(deviceId: string | undefined, processing: AudioProcessing): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: processing.echoCancellation,
      noiseSuppression: processing.noiseSuppression,
      autoGainControl: processing.autoGainControl,
      channelCount: 1,
    },
    video: false,
  });
}

export async function acquireCamera(deviceId: string | undefined): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      width: { ideal: 640 },
      height: { ideal: 360 },
      frameRate: { ideal: 15, max: 24 },
    },
  });
}

export function stopStream(s: MediaStream | null | undefined) {
  s?.getTracks().forEach((t) => t.stop());
}

export async function listDevices(): Promise<{ mics: MediaDeviceInfo[]; cams: MediaDeviceInfo[]; speakers: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { mics: [], cams: [], speakers: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    mics: all.filter((d) => d.kind === 'audioinput'),
    cams: all.filter((d) => d.kind === 'videoinput'),
    speakers: all.filter((d) => d.kind === 'audiooutput'),
  };
}

export function createAudioContext(): AudioContext | null {
  const Ctor: typeof AudioContext | undefined = (window as any).AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

/** Route the AudioContext output to a chosen speaker where supported (Chrome 110+). */
export async function setOutputDevice(ctx: AudioContext, sinkId: string): Promise<boolean> {
  const c = ctx as any;
  if (typeof c.setSinkId !== 'function') return false;
  try {
    await c.setSinkId(sinkId === 'default' ? '' : sinkId);
    return true;
  } catch {
    return false;
  }
}

/** A short two-note chime for the speaker test. */
export async function playTestTone(ctx: AudioContext): Promise<void> {
  if (ctx.state === 'suspended') await ctx.resume();
  const now = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.25, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.9);
  for (const [freq, at] of [
    [660, 0],
    [880, 0.25],
  ] as const) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(now + at);
    osc.stop(now + at + 0.6);
  }
  await new Promise((r) => setTimeout(r, 950));
  gain.disconnect();
}

const PREF_KEY = 'cf:devices';
export function loadDevicePrefs(): { mic?: string; cam?: string; speaker?: string } {
  try {
    return JSON.parse(localStorage.getItem(PREF_KEY) ?? '{}');
  } catch {
    return {};
  }
}
export function saveDevicePrefs(p: { mic?: string; cam?: string; speaker?: string }) {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
