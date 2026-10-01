import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Recall.ai integration helpers.
 *
 * API: https://<region>.recall.ai/api/v1/bot/  (Authorization: Token <api key>)
 * Webhooks are signed with the Svix scheme using the workspace verification secret (whsec_…):
 *   signed content = "<webhook-id>.<webhook-timestamp>.<raw body>"
 *   signature      = base64(HMAC-SHA256(base64decode(secret without "whsec_"), signed content))
 *   header         = "v1,<sig> v1,<sig2> …"   (headers webhook-* or svix-*)
 */
export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;

export function recallBaseUrl(region: string): string {
  const r = (RECALL_REGIONS as readonly string[]).includes(region) ? region : 'us-east-1';
  return `https://${r}.recall.ai/api/v1`;
}

export function verifySvixSignature(
  secret: string,
  headers: Record<string, string | string[] | undefined>,
  rawBody: string | Buffer,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): boolean {
  const h = (name: string) => {
    const v = headers[`webhook-${name}`] ?? headers[`svix-${name}`];
    return Array.isArray(v) ? v[0] : v;
  };
  const id = h('id');
  const ts = h('timestamp');
  const sigHeader = h('signature');
  if (!secret || !id || !ts || !sigHeader || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowSec - Number(ts)) > toleranceSec) return false;
  const key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
  const expected = createHmac('sha256', key)
    .update(`${id}.${ts}.`)
    .update(rawBody)
    .digest();
  return sigHeader.split(' ').some((part) => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === expected.length && timingSafeEqual(got, expected);
  });
}

/** Meeting URLs we accept (Zoom, Google Meet, Microsoft Teams). Returns the platform or null. */
export function meetingPlatform(raw: string): 'zoom' | 'google_meet' | 'microsoft_teams' | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  const host = u.hostname.toLowerCase();
  if ((host === 'zoom.us' || host.endsWith('.zoom.us') || host === 'zoomgov.com' || host.endsWith('.zoomgov.com')) && /^\/(j|w|my|wc\/join)\//.test(u.pathname)) return 'zoom';
  if (host === 'meet.google.com' && /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(u.pathname)) return 'google_meet';
  if ((host === 'teams.microsoft.com' || host === 'teams.live.com') && u.pathname.length > 1) return 'microsoft_teams';
  return null;
}

export const MEETING_BOT_MODES = ['notetaker', 'agent'] as const;
export type MeetingBotMode = (typeof MEETING_BOT_MODES)[number];

/**
 * Create-bot request body.
 * - notetaker: real-time transcript utterances are pushed to our webhook; nobody speaks.
 * - agent: Recall "output media" — the bot's browser opens our bot page, whose audio becomes the bot's
 *   microphone and whose rendering becomes its camera; the page hears the meeting via getUserMedia and
 *   runs the normal live session. The web variant (4 cores) keeps live audio smooth on every platform.
 */
export function recallBotRequest(o: {
  mode: MeetingBotMode;
  meetingUrl: string;
  botName: string;
  joinAt?: Date | null;
  language: string;
  /** notetaker: our per-bot realtime webhook URL. */
  realtimeEndpointUrl?: string;
  /** agent: the bot page URL (carries the session token in the fragment). */
  botPageUrl?: string;
  metadata: Record<string, string>;
}): Record<string, unknown> {
  const base = {
    meeting_url: o.meetingUrl,
    bot_name: o.botName,
    ...(o.joinAt ? { join_at: o.joinAt.toISOString() } : {}),
    metadata: o.metadata,
  };
  if (o.mode === 'agent') {
    if (!o.botPageUrl) throw new Error('botPageUrl is required for agent bots');
    return {
      ...base,
      output_media: { camera: { kind: 'webpage', config: { url: o.botPageUrl } } },
      variant: { zoom: 'web_4_core', google_meet: 'web_4_core', microsoft_teams: 'web_4_core' },
    };
  }
  if (!o.realtimeEndpointUrl) throw new Error('realtimeEndpointUrl is required for notetaker bots');
  return {
    ...base,
    recording_config: {
      transcript: { provider: { recallai_streaming: { mode: 'prioritize_low_latency', language_code: o.language.slice(0, 2).toLowerCase() } } },
      realtime_endpoints: [{ type: 'webhook', url: o.realtimeEndpointUrl, events: ['transcript.data'] }],
    },
  };
}

/** Recall bot status codes → MeetingBot.status. */
export function mapRecallStatus(code: string): 'JOINING' | 'IN_CALL' | 'COMPLETED' | 'FAILED' | null {
  switch (code) {
    case 'ready':
    case 'joining_call':
    case 'in_waiting_room':
      return 'JOINING';
    case 'in_call_not_recording':
    case 'recording_permission_allowed':
    case 'in_call_recording':
      return 'IN_CALL';
    case 'call_ended':
    case 'done':
    case 'analysis_done':
      return 'COMPLETED';
    case 'fatal':
    case 'recording_permission_denied':
      return 'FAILED';
    default:
      return null;
  }
}

export interface RecallWord {
  text: string;
  start_timestamp?: { relative?: number } | null;
  end_timestamp?: { relative?: number } | null;
}

/** A `transcript.data` realtime event → one utterance. */
export function utteranceFromTranscriptEvent(payload: any): {
  botId: string | null;
  text: string;
  speaker: { id: string | null; name: string | null; isHost: boolean | null };
  startMs: number | null;
  endMs: number | null;
} | null {
  const inner = payload?.data?.data;
  const words: RecallWord[] = Array.isArray(inner?.words) ? inner.words : [];
  const text = words
    .map((w) => String(w?.text ?? ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return null;
  const first = words[0]?.start_timestamp?.relative;
  const last = words[words.length - 1]?.end_timestamp?.relative;
  const p = inner?.participant ?? {};
  return {
    botId: typeof payload?.data?.bot?.id === 'string' ? payload.data.bot.id : null,
    text: text.slice(0, 8000),
    speaker: {
      id: p.id !== undefined && p.id !== null ? String(p.id) : null,
      name: typeof p.name === 'string' ? p.name.slice(0, 120) : null,
      isHost: typeof p.is_host === 'boolean' ? p.is_host : null,
    },
    startMs: typeof first === 'number' ? Math.round(first * 1000) : null,
    endMs: typeof last === 'number' ? Math.round(last * 1000) : null,
  };
}
