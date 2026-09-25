/**
 * Participant session REST client (workstream B endpoints under /api/runtime/sessions/:id),
 * authenticated with the per-session bearer token (`cfs_…`). Requests go through the web app's
 * same-origin /api proxy.
 */

import type { ClientRuntimeConfig, SessionState } from '@cf/shared';
import { api, ApiError } from '../api';

export interface ConsentChoice {
  recordAudio: boolean;
  recordVideo: boolean;
  analysis: boolean;
}

export interface LiveBootstrap {
  sessionId: string;
  state: SessionState;
  scenario: {
    name: string;
    type?: string;
    publicDescription: string;
    participantInstructions: string;
    estimatedMinutes: number | null;
  };
  persona: ClientRuntimeConfig['persona'];
  consent: {
    /** Consent must be submitted before the call (recording or analysis enabled). */
    required: boolean;
    /** Already given (resume after refresh). */
    given: (ConsentChoice & { acceptedAt?: string }) | null;
    /** What the scenario asks for. */
    recordAudio: boolean;
    recordVideo: boolean;
    analysis: boolean;
    /** The organizer requires analysis consent (e.g. assessments). */
    analysisRequired: boolean;
    retentionDays: number | null;
    notice: string;
  };
  config: ClientRuntimeConfig;
  branding: NonNullable<ClientRuntimeConfig['branding']>;
  participantCanSeeFeedback: boolean;
  maxDurationSec: number | null;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number | null;
  endReason: string | null;
}

const base = (id: string) => `/api/runtime/sessions/${encodeURIComponent(id)}`;

function pick<T>(...vals: unknown[]): T | undefined {
  for (const v of vals) if (v !== undefined && v !== null) return v as T;
  return undefined;
}

/**
 * Normalize the bootstrap payload. The contract lists its content (scenario public info, consent
 * needs, state, ClientRuntimeConfig); we accept a few equivalent shapes so small server-side naming
 * differences do not break the participant page.
 */
export function normalizeBootstrap(raw: any, sessionId: string): LiveBootstrap {
  const r = raw?.data && !raw?.config ? raw.data : raw;
  const session = r?.session ?? {};
  const scenario = r?.scenario ?? {};
  const config: ClientRuntimeConfig = r?.config ?? r?.runtimeConfig ?? r?.clientConfig;
  if (!config) throw new ApiError(500, 'bad_bootstrap', 'The session could not be loaded (missing runtime config).');
  const c = r?.consent ?? {};
  // `given` may be the consent record itself or a boolean with the record under `recorded`.
  const given = pick<any>(
    c.recorded,
    typeof c.given === 'object' ? c.given : undefined,
    c.current,
    session.consent && Object.keys(session.consent).length ? session.consent : undefined,
    c.given === true ? { acceptedAt: 'unknown', recordAudio: false, recordVideo: false, analysis: true } : undefined,
  );
  const recordAudio = !!pick(c.recordAudio, c.recording?.audio, config.recording?.audio);
  const recordVideo = !!pick(c.recordVideo, c.recording?.video, config.recording?.video);
  const analysis = pick<boolean>(c.analysis, c.analysisEnabled, r?.analysis?.enabled) ?? true;
  const est = pick<number>(
    scenario.estimatedMinutes,
    scenario.estimatedDurationMinutes,
    scenario.targetDurationMinutes,
    r?.estimatedMinutes,
  );
  const maxDurationSec = pick<number>(session.maxDurationSec, r?.maxDurationSec);
  const givenNorm =
    given && typeof given === 'object' && ('recordAudio' in given || 'analysis' in given || 'acceptedAt' in given)
      ? {
          recordAudio: !!given.recordAudio,
          recordVideo: !!given.recordVideo,
          analysis: !!given.analysis,
          acceptedAt: given.acceptedAt,
        }
      : null;
  return {
    sessionId: pick<string>(session.id, r?.id, sessionId)!,
    state: pick<SessionState>(session.state, r?.state) ?? 'CREATED',
    scenario: {
      name: pick<string>(scenario.name, session.scenarioName, r?.scenarioName) ?? 'Conversation',
      type: scenario.type,
      publicDescription: pick<string>(scenario.publicDescription, scenario.description) ?? '',
      participantInstructions: pick<string>(scenario.participantInstructions, config.participantInstructions) ?? '',
      estimatedMinutes: typeof est === 'number' ? est : null,
    },
    persona: config.persona ?? { name: '', role: '', avatar: { kind: 'initials' } },
    consent: {
      required: pick<boolean>(c.required, c.needed, r?.consentRequired) ?? (recordAudio || recordVideo || analysis),
      given: givenNorm,
      recordAudio,
      recordVideo,
      analysis,
      analysisRequired: !!pick(c.analysisRequired, c.requireAnalysis),
      retentionDays: pick<number>(c.retentionDays, r?.retentionDays) ?? null,
      notice: pick<string>(c.notice, c.consentNotice, r?.consentNotice) ?? '',
    },
    config,
    branding: { ...(r?.branding ?? {}), ...(config.branding ?? {}) },
    participantCanSeeFeedback: !!pick(
      r?.participantCanSeeFeedback,
      r?.report?.participantCanSeeFeedback,
      r?.report?.available,
      r?.analysis?.participantCanSeeFeedback,
      scenario.participantCanSeeFeedback,
    ),
    maxDurationSec: typeof maxDurationSec === 'number' ? maxDurationSec : null,
    startedAt: pick<string>(session.startedAt, r?.startedAt) ?? null,
    endedAt: pick<string>(session.endedAt, r?.endedAt) ?? null,
    durationMs: pick<number>(session.durationMs, r?.durationMs) ?? null,
    endReason: pick<string>(session.stateReason, session.endReason, r?.stateReason) ?? null,
  };
}

export async function fetchBootstrap(sessionId: string, token: string): Promise<LiveBootstrap> {
  const raw = await api(base(sessionId), { token, cache: 'no-store' });
  return normalizeBootstrap(raw, sessionId);
}

export async function submitConsent(sessionId: string, token: string, choice: ConsentChoice) {
  return api(`${base(sessionId)}/consent`, { method: 'POST', token, body: { ...choice } });
}

export interface RealtimeCredentials {
  clientSecret: string;
  model: string;
  /** SDP exchange endpoint (defaults to OpenAI's GA calls endpoint). */
  callsUrl: string;
  expiresAt?: string | number;
}

export async function fetchRealtimeToken(sessionId: string, token: string): Promise<RealtimeCredentials> {
  const r: any = await api(`${base(sessionId)}/realtime-token`, { method: 'POST', token, body: {} });
  const secret = pick<string>(r?.clientSecret, r?.client_secret?.value, r?.value, r?.token, r?.ephemeralKey);
  if (!secret) throw new ApiError(502, 'realtime_unavailable', 'No realtime credentials returned');
  return {
    clientSecret: secret,
    model: pick<string>(r?.model, r?.session?.model) ?? 'gpt-realtime',
    callsUrl: pick<string>(r?.callsUrl, r?.url, r?.sdpUrl) ?? 'https://api.openai.com/v1/realtime/calls',
    expiresAt: pick(r?.expiresAt, r?.expires_at, r?.client_secret?.expires_at),
  };
}

export async function createRecording(
  sessionId: string,
  token: string,
  body: { kind: 'audio' | 'video'; mimeType: string },
): Promise<{ assetId: string }> {
  const r: any = await api(`${base(sessionId)}/recordings`, { method: 'POST', token, body });
  const assetId = pick<string>(r?.assetId, r?.id, r?.asset?.id);
  if (!assetId) throw new ApiError(502, 'bad_response', 'Recording could not be created');
  return { assetId };
}

export async function putRecordingPart(sessionId: string, token: string, assetId: string, n: number, blob: Blob) {
  return api(`${base(sessionId)}/recordings/${encodeURIComponent(assetId)}/parts/${n}`, {
    method: 'PUT',
    token,
    body: blob,
    headers: { 'Content-Type': (blob.type || 'application/octet-stream').split(';')[0]! },
  });
}

export function completeRecordingUrl(sessionId: string, assetId: string) {
  return `${base(sessionId)}/recordings/${encodeURIComponent(assetId)}/complete`;
}

export async function completeRecording(
  sessionId: string,
  token: string,
  assetId: string,
  body: { durationMs: number },
  keepalive = false,
) {
  return api(completeRecordingUrl(sessionId, assetId), { method: 'POST', token, body: { durationMs: Math.round(body.durationMs) }, keepalive });
}

export interface UploadResult {
  assetId: string;
  fileName?: string;
  sizeBytes?: number;
  mimeType?: string;
  [k: string]: unknown;
}

export async function uploadFile(
  sessionId: string,
  token: string,
  file: Blob,
  fileName: string,
  fields: Record<string, string> = {},
): Promise<UploadResult> {
  // Metadata (e.g. toolCallId) goes in the query string; the multipart body carries only the file.
  const fd = new FormData();
  fd.append('file', file, fileName);
  const r: any = await api(`${base(sessionId)}/uploads`, { method: 'POST', token, body: fd, query: fields });
  const assetId = pick<string>(r?.assetId, r?.id, r?.asset?.id);
  if (!assetId) throw new ApiError(502, 'bad_response', 'Upload failed');
  return { ...r, assetId };
}

/** Server TTS: returns playable audio bytes + mime type. */
export async function synthesize(sessionId: string, token: string, text: string, signal?: AbortSignal) {
  const res = await fetch(`${base(sessionId)}/tts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.error?.code ?? 'tts_failed', data?.error?.message ?? 'Speech synthesis failed');
  }
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('application/json')) {
    const j: any = await res.json();
    const b64 = pick<string>(j?.audio, j?.data, j?.audioBase64);
    if (!b64) throw new ApiError(502, 'tts_failed', 'No audio returned');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime: pick<string>(j?.mime, j?.mimeType) ?? 'audio/mpeg' };
  }
  return { bytes: new Uint8Array(await res.arrayBuffer()), mime: ct || 'audio/mpeg' };
}

/** Server STT: sends one utterance segment as a binary body and returns the transcript. */
export async function transcribe(sessionId: string, token: string, audio: Blob, _lang: string) {
  const r: any = await api(`${base(sessionId)}/stt`, {
    method: 'POST',
    token,
    body: audio,
    headers: { 'Content-Type': (audio.type || 'audio/wav').split(';')[0]! },
  });
  return { text: String(pick(r?.text, r?.transcript) ?? '').trim(), confidence: pick<number>(r?.confidence) };
}

export { ApiError };
