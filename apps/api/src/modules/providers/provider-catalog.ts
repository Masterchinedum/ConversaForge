import { z } from 'zod';

/** Supported BYO-key providers, the capabilities each can serve, and their config fields. */

export const PROVIDER_IDS = ['anthropic', 'openai', 'deepgram', 'elevenlabs', 'twilio', 'recall', 'google_calendar'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const PROVIDER_KINDS = ['LLM', 'REALTIME', 'TTS', 'STT', 'TELEPHONY', 'MEETING', 'CALENDAR'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  /** Capabilities this provider can serve. */
  capabilities: ProviderKind[];
  /** Enabled by default when a key is added. */
  defaultCapabilities: ProviderKind[];
  secretLabel: string;
  secretHelp: string;
  /** Twilio needs two secrets (account SID + auth token). */
  compositeSecret?: boolean;
  docsUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    capabilities: ['LLM'],
    defaultCapabilities: ['LLM'],
    secretLabel: 'API key',
    secretHelp: 'Starts with sk-ant-. Create one at console.anthropic.com → API keys.',
    docsUrl: 'https://docs.anthropic.com/en/api/getting-started',
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    capabilities: ['LLM', 'REALTIME', 'TTS', 'STT'],
    defaultCapabilities: ['LLM', 'REALTIME', 'TTS', 'STT'],
    secretLabel: 'API key',
    secretHelp: 'Starts with sk-. Create one at platform.openai.com → API keys.',
    docsUrl: 'https://platform.openai.com/docs/api-reference',
  },
  deepgram: {
    id: 'deepgram',
    name: 'Deepgram',
    capabilities: ['STT', 'TTS'],
    defaultCapabilities: ['STT'],
    secretLabel: 'API key',
    secretHelp: 'Create one in the Deepgram console → API Keys.',
    docsUrl: 'https://developers.deepgram.com/reference',
  },
  elevenlabs: {
    id: 'elevenlabs',
    name: 'ElevenLabs',
    capabilities: ['TTS', 'STT'],
    defaultCapabilities: ['TTS'],
    secretLabel: 'API key',
    secretHelp: 'Profile → API keys in the ElevenLabs dashboard.',
    docsUrl: 'https://elevenlabs.io/docs/api-reference',
  },
  twilio: {
    id: 'twilio',
    name: 'Twilio',
    capabilities: ['TELEPHONY'],
    defaultCapabilities: ['TELEPHONY'],
    secretLabel: 'Auth token',
    secretHelp: 'Account SID (AC…) and auth token from the Twilio console.',
    compositeSecret: true,
    docsUrl: 'https://www.twilio.com/docs/usage/api',
  },
  recall: {
    id: 'recall',
    name: 'Recall.ai (meeting bots)',
    capabilities: ['MEETING'],
    defaultCapabilities: ['MEETING'],
    secretLabel: 'API key',
    secretHelp: 'Recall.ai dashboard → API keys. Pick the region your account lives in.',
    docsUrl: 'https://docs.recall.ai/reference',
  },
  google_calendar: {
    id: 'google_calendar',
    name: 'Google Calendar',
    capabilities: ['CALENDAR'],
    defaultCapabilities: ['CALENDAR'],
    secretLabel: 'API key or OAuth refresh token',
    secretHelp: 'Stored encrypted for scheduling integrations. Verification is not available for this provider yet.',
    docsUrl: 'https://developers.google.com/calendar/api',
  },
};

export const RECALL_REGIONS = ['us-east-1', 'us-west-2', 'eu-central-1', 'ap-northeast-1'] as const;

const modelId = z.string().trim().min(1).max(100).regex(/^[A-Za-z0-9._:/-]+$/, 'Invalid model id');

/** Non-secret configuration stored in ProviderConnection.config. */
export const ProviderConfigSchema = z
  .object({
    capabilities: z.array(z.enum(PROVIDER_KINDS)).max(7).optional(),
    liveModel: modelId.optional(),
    analysisModel: modelId.optional(),
    realtimeModel: modelId.optional(),
    ttsModel: modelId.optional(),
    sttModel: modelId.optional(),
    voice: z.string().trim().max(100).optional(),
    region: z.enum(RECALL_REGIONS).optional(),
    accountSid: z.string().trim().regex(/^AC[a-fA-F0-9]{32}$/, 'Account SID must look like AC followed by 32 hex characters').optional(),
    phoneNumber: z.string().trim().max(32).optional(),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/**
 * `kind` column: "LLM" whenever the connection serves LLM (LlmService.resolve reads kind='LLM'),
 * otherwise the first enabled capability. All capabilities live in config.capabilities.
 */
export function primaryKind(provider: ProviderId, capabilities: ProviderKind[]): ProviderKind {
  if (capabilities.includes('LLM')) return 'LLM';
  return capabilities[0] ?? PROVIDERS[provider].defaultCapabilities[0]!;
}

export function normalizeCapabilities(provider: ProviderId, caps: ProviderKind[] | undefined): ProviderKind[] {
  const allowed = PROVIDERS[provider].capabilities;
  const list = (caps?.length ? caps : PROVIDERS[provider].defaultCapabilities).filter((c) => allowed.includes(c));
  return [...new Set(list)];
}

/** Capabilities of a stored connection (older rows without config.capabilities → their kind). */
export function connectionCapabilities(conn: { provider: string; kind: string; config: unknown }): ProviderKind[] {
  const caps = (conn.config as { capabilities?: unknown } | null)?.capabilities;
  if (Array.isArray(caps) && caps.length) return caps.filter((c): c is ProviderKind => (PROVIDER_KINDS as readonly string[]).includes(c));
  return (PROVIDER_KINDS as readonly string[]).includes(conn.kind) ? [conn.kind as ProviderKind] : [];
}
