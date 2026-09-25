import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';
import { AppError } from '../../common/http/errors';
import { LlmService } from '../../common/llm/llm.service';
import { recallBaseUrl } from './recall/recall';

export interface TwilioCreds {
  accountSid: string;
  authToken: string;
  source: 'workspace' | 'environment';
}
export interface RecallCreds {
  apiKey: string;
  region: string;
  source: 'workspace' | 'environment';
}

export const TWILIO_MISSING =
  'Not configured — requires TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN on the server (or a Twilio connection in Settings → AI providers).';
export const RECALL_MISSING = 'Not configured — requires RECALL_API_KEY (and RECALL_REGION) on the server (or a Recall.ai connection in Settings → AI providers).';
export const SPEECH_MISSING =
  'Phone calls need server speech: speech-to-text requires OPENAI_API_KEY or DEEPGRAM_API_KEY, and text-to-speech requires OPENAI_API_KEY or ELEVENLABS_API_KEY (or matching workspace connections).';

/** Parse the Twilio credential from a workspace connection (JSON) or the env ("SID:TOKEN"). */
export function parseTwilioCredential(secret: string, config: Record<string, unknown> = {}): { accountSid: string | null; authToken: string | null } {
  const s = secret.trim();
  if (s.startsWith('{')) {
    try {
      const j = JSON.parse(s);
      return { accountSid: typeof j.accountSid === 'string' ? j.accountSid : null, authToken: typeof j.authToken === 'string' ? j.authToken : null };
    } catch {
      return { accountSid: null, authToken: null };
    }
  }
  const idx = s.indexOf(':');
  if (idx > 0 && s.startsWith('AC')) return { accountSid: s.slice(0, idx), authToken: s.slice(idx + 1) };
  return { accountSid: typeof config.accountSid === 'string' ? config.accountSid : null, authToken: s || null };
}

/** Credentials and readiness for the phone/meeting channels. Never falls back to a simulation. */
@Injectable()
export class ChannelProvidersService {
  constructor(private readonly llm: LlmService) {}

  async twilio(workspaceId: string): Promise<TwilioCreds | null> {
    const s = await this.llm.providerSecret(workspaceId, 'twilio');
    if (!s) return null;
    const { accountSid, authToken } = parseTwilioCredential(s.secret, s.config);
    if (!accountSid || !authToken) return null;
    return { accountSid, authToken, source: s.source };
  }

  async recall(workspaceId: string): Promise<RecallCreds | null> {
    const s = await this.llm.providerSecret(workspaceId, 'recall');
    if (!s) return null;
    const region = typeof s.config.region === 'string' ? s.config.region : env.RECALL_REGION;
    return { apiKey: s.secret, region, source: s.source };
  }

  async speech(workspaceId: string) {
    const [openai, deepgram, elevenlabs] = await Promise.all([
      this.llm.providerSecret(workspaceId, 'openai'),
      this.llm.providerSecret(workspaceId, 'deepgram'),
      this.llm.providerSecret(workspaceId, 'elevenlabs'),
    ]);
    const stt = deepgram ? 'deepgram' : openai ? 'openai' : null;
    const tts = elevenlabs ? 'elevenlabs' : openai ? 'openai' : null;
    return { stt, tts, ready: !!(stt && tts) } as const;
  }

  /** Twilio must reach our webhooks and media stream over public HTTPS/WSS. */
  publicUrlStatus() {
    let url: URL | null = null;
    try {
      url = new URL(env.API_PUBLIC_URL);
    } catch {
      /* invalid */
    }
    const host = url?.hostname ?? '';
    const local = !url || ['localhost', '127.0.0.1', '::1', '[::1]'].includes(host) || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
    const ok = !!url && url.protocol === 'https:' && !local;
    return {
      apiPublicUrl: env.API_PUBLIC_URL,
      ok,
      reason: ok ? null : 'API_PUBLIC_URL must be a public https:// URL that Twilio/Recall can reach (webhooks and wss:// media streams).',
    };
  }

  async availability(workspaceId: string) {
    const [tw, rc, speech] = await Promise.all([this.twilio(workspaceId), this.recall(workspaceId), this.speech(workspaceId)]);
    const publicUrl = this.publicUrlStatus();
    return {
      twilio: { configured: !!tw, source: tw?.source ?? null, reason: tw ? null : TWILIO_MISSING },
      recall: {
        configured: !!rc,
        source: rc?.source ?? null,
        region: rc?.region ?? null,
        reason: rc ? null : RECALL_MISSING,
        webhookSecretConfigured: !!env.RECALL_WEBHOOK_SECRET,
      },
      speech: { ...speech, reason: speech.ready ? null : SPEECH_MISSING },
      publicUrl,
      phoneReady: !!tw && speech.ready && publicUrl.ok,
      meetingsReady: !!rc && publicUrl.ok,
    };
  }

  async requireTwilio(workspaceId: string): Promise<TwilioCreds> {
    const c = await this.twilio(workspaceId);
    if (!c) throw new AppError(503, 'provider_unavailable', TWILIO_MISSING, { missing: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN'] });
    return c;
  }

  async requireRecall(workspaceId: string): Promise<RecallCreds> {
    const c = await this.recall(workspaceId);
    if (!c) throw new AppError(503, 'provider_unavailable', RECALL_MISSING, { missing: ['RECALL_API_KEY'] });
    return c;
  }

  recallUrl(creds: RecallCreds, path: string) {
    return `${recallBaseUrl(creds.region)}${path}`;
  }
}

/** Twilio REST (2010-04-01) with Basic auth; form-encoded bodies. */
export async function twilioRequest<T = any>(
  creds: Pick<TwilioCreds, 'accountSid' | 'authToken'>,
  method: 'GET' | 'POST',
  path: string,
  form?: Array<[string, string]>,
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(creds.accountSid)}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.accountSid}:${creds.authToken}`).toString('base64')}`,
      ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      Accept: 'application/json',
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error */
  }
  if (!res.ok) {
    const msg = json?.message ? `Twilio: ${json.message}` : `Twilio request failed (${res.status})`;
    throw new AppError(502, 'provider_error', msg, { status: res.status, twilioCode: json?.code ?? null });
  }
  return json as T;
}
