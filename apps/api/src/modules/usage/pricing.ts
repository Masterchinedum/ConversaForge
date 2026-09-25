import type { UsageKind } from '@cf/shared';

/**
 * Estimated list prices in USD, used to attribute cost to sessions/workspaces.
 * These are estimates for internal cost control — update when vendor pricing changes.
 * Units: per 1M tokens, per minute, per 1M characters, per GB-month.
 */
export const PRICE_TABLE: Record<string, { inPerMTok?: number; outPerMTok?: number; perMinute?: number; perMChars?: number }> = {
  // Anthropic (per 1M tokens)
  'anthropic:claude-opus-5': { inPerMTok: 5, outPerMTok: 25 },
  'anthropic:claude-opus-5-5': { inPerMTok: 4, outPerMTok: 20 },
  'anthropic:claude-sonnet-5': { inPerMTok: 2, outPerMTok: 10 },
  'anthropic:claude-haiku-4-5': { inPerMTok: 1, outPerMTok: 5 },
  'anthropic:default': { inPerMTok: 5, outPerMTok: 25 },
  // OpenAI (estimates; verify against current pricing)
  'openai:default': { inPerMTok: 2, outPerMTok: 8 },
  'openai:realtime': { perMinute: 0.3 },
  'openai:tts': { perMChars: 15 },
  'openai:stt': { perMinute: 0.006 },
  'deepgram:stt': { perMinute: 0.0077 },
  'elevenlabs:tts': { perMChars: 180 },
  'twilio:voice': { perMinute: 0.014 },
  'recall:bot': { perMinute: 0.0117 },
  'browser:stt': { perMinute: 0 },
  'browser:tts': { perMChars: 0 },
  'simulator:default': {},
};

export function estimateCostMicros(kind: UsageKind, provider: string, model: string | undefined, quantity: number): number {
  const p =
    PRICE_TABLE[`${provider}:${model ?? ''}`] ??
    PRICE_TABLE[`${provider}:${kindKey(kind)}`] ??
    PRICE_TABLE[`${provider}:default`] ??
    {};
  let usd = 0;
  switch (kind) {
    case 'LLM_INPUT_TOKENS':
    case 'ANALYSIS_INPUT_TOKENS':
    case 'EMBEDDING_TOKENS':
      usd = ((p.inPerMTok ?? 0) * quantity) / 1_000_000;
      break;
    case 'LLM_OUTPUT_TOKENS':
    case 'ANALYSIS_OUTPUT_TOKENS':
      usd = ((p.outPerMTok ?? 0) * quantity) / 1_000_000;
      break;
    case 'STT_SECONDS':
    case 'REALTIME_SECONDS':
    case 'TELEPHONY_SECONDS':
      usd = ((p.perMinute ?? 0) * quantity) / 60;
      break;
    case 'TTS_CHARACTERS':
      usd = ((p.perMChars ?? 0) * quantity) / 1_000_000;
      break;
    case 'STORAGE_BYTES':
      usd = (0.023 * quantity) / 1e9; // ~S3 standard per GB-month
      break;
    case 'SESSION_SECONDS':
      usd = 0;
      break;
  }
  return Math.round(usd * 1_000_000);
}

function kindKey(kind: UsageKind): string {
  switch (kind) {
    case 'STT_SECONDS':
      return 'stt';
    case 'TTS_CHARACTERS':
      return 'tts';
    case 'REALTIME_SECONDS':
      return 'realtime';
    case 'TELEPHONY_SECONDS':
      return 'voice';
    default:
      return 'default';
  }
}
