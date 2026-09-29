import { Injectable } from '@nestjs/common';
import type { Channel, RealtimeProviderChoice, RealtimeProviderId, ScenarioConfig, SttProviderId, TtsProviderId } from '@cf/shared';
import { env } from '../../../config/env';
import { LlmService } from '../../../common/llm/llm.service';
import { LlmUnavailableError, type ResolvedLlm } from '../../../common/llm/llm.types';
import { Errors } from '../../../common/http/errors';
import type { ProviderInfo } from '../runtime.types';

/**
 * Decides which voice mode / LLM / STT / TTS a session will use, based on the scenario version's
 * wishes and which credentials are actually available (workspace BYO keys first, then server env).
 * Falls back gracefully (realtime → pipeline, server STT/TTS → browser) and records why.
 */
@Injectable()
export class ProviderResolverService {
  constructor(private readonly llm: LlmService) {}

  async resolveLlm(workspaceId: string, config: ScenarioConfig, forceSimulator = false): Promise<ResolvedLlm> {
    return this.llm.resolve(
      workspaceId,
      'live',
      forceSimulator ? 'simulator' : config.model.llmProvider,
      config.model.llmModel || null,
    );
  }

  async resolve(
    workspaceId: string,
    config: ScenarioConfig,
    opts: {
      channel: Channel;
      workspaceSettings?: Record<string, unknown>;
      /** Audio runs in a browser page even on a MEETING channel (the Recall output-media bot page). */
      mediaInBrowser?: boolean;
    },
  ): Promise<ProviderInfo> {
    let llm: ResolvedLlm;
    try {
      llm = await this.resolveLlm(workspaceId, config);
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw Errors.unavailable(e.message, { missing: 'ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY' });
      throw e;
    }
    if (llm.simulated && opts.workspaceSettings?.allowSimulator === false && config.model.llmProvider !== 'simulator') {
      throw Errors.unavailable(
        'No AI provider is configured for this workspace and the local simulator is disabled. Add an Anthropic, OpenAI or Google Gemini key.',
        { missing: 'ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY' },
      );
    }

    const fallbacks: string[] = [];
    const openai = !!(await this.llm.providerSecret(workspaceId, 'openai'));
    // Live voice honours the connection's capability checkboxes (Settings → AI providers).
    const openaiSecret = await this.llm.providerSecret(workspaceId, 'openai', 'REALTIME');
    const googleSecret = await this.llm.providerSecret(workspaceId, 'google', 'REALTIME');
    const deepgram = !!(await this.llm.providerSecret(workspaceId, 'deepgram'));
    const elevenlabs = !!(await this.llm.providerSecret(workspaceId, 'elevenlabs'));
    const isPhone = opts.channel === 'PHONE_INBOUND' || opts.channel === 'PHONE_OUTBOUND' || (opts.channel === 'MEETING' && !opts.mediaInBrowser);

    let voiceMode = config.model.voiceMode;
    const requestedLive: RealtimeProviderChoice = config.model.realtimeProvider ?? 'auto';
    let realtime: ProviderInfo['realtime'];
    if (voiceMode === 'realtime') {
      if (isPhone) {
        voiceMode = 'pipeline';
        fallbacks.push('Live speech-to-speech voice runs in the browser only; phone calls and meeting notetakers use the speech pipeline.');
      } else {
        const pick = pickLiveProvider(requestedLive, { openai: openaiSecret, google: googleSecret });
        if (!pick.provider) {
          voiceMode = 'pipeline';
          fallbacks.push(
            requestedLive === 'auto'
              ? 'Live voice unavailable: no live-model key is configured (OPENAI_API_KEY or GEMINI_API_KEY, or a workspace OpenAI/Google connection); using the speech pipeline instead.'
              : `${LIVE_NAMES[requestedLive]} was requested but no ${requestedLive === 'openai' ? 'OpenAI key (OPENAI_API_KEY' : 'Google key (GEMINI_API_KEY'} or a workspace connection) is configured, and no other live provider is available; using the speech pipeline instead.`,
          );
        } else {
          if (requestedLive !== 'auto' && pick.provider !== requestedLive) {
            fallbacks.push(
              `${LIVE_NAMES[requestedLive]} was requested but no ${requestedLive === 'openai' ? 'OpenAI key (OPENAI_API_KEY' : 'Google key (GEMINI_API_KEY'} or a workspace connection) is configured; using ${LIVE_NAMES[pick.provider]} instead.`,
            );
          }
          const secrets = { openai: openaiSecret, google: googleSecret };
          const live = (provider: RealtimeProviderId) => ({
            provider,
            model: liveModel(provider, config.model.realtimeModel, requestedLive, secrets[provider]?.config),
            source: secrets[provider]!.source,
          });
          realtime = { ...live(pick.provider), ...(pick.backup ? { backup: live(pick.backup) } : {}) };
        }
      }
    }

    let stt: SttProviderId = config.model.sttProvider;
    if (stt === 'openai' && !openai) {
      fallbacks.push('OpenAI speech-to-text requested but OPENAI_API_KEY is not configured; using browser speech recognition.');
      stt = 'browser';
    } else if (stt === 'deepgram' && !deepgram) {
      fallbacks.push('Deepgram speech-to-text requested but DEEPGRAM_API_KEY is not configured; using browser speech recognition.');
      stt = 'browser';
    }
    let tts: TtsProviderId = config.model.ttsProvider;
    if (tts === 'openai' && !openai) {
      fallbacks.push('OpenAI text-to-speech requested but OPENAI_API_KEY is not configured; using browser speech synthesis.');
      tts = 'browser';
    } else if (tts === 'elevenlabs' && !elevenlabs) {
      fallbacks.push('ElevenLabs text-to-speech requested but ELEVENLABS_API_KEY is not configured; using browser speech synthesis.');
      tts = 'browser';
    }
    if (isPhone) {
      // Phone audio never reaches a browser: server STT/TTS are required (the channel bridge picks them).
      if (stt === 'browser' || stt === 'typed') stt = deepgram ? 'deepgram' : openai ? 'openai' : stt;
      if (tts === 'browser' || tts === 'none') tts = elevenlabs ? 'elevenlabs' : openai ? 'openai' : tts;
    }

    const simulatedParts: string[] = [];
    if (voiceMode === 'pipeline' && llm.simulated) simulatedParts.push('llm');

    return {
      voiceMode,
      requestedVoiceMode: config.model.voiceMode,
      llm: { provider: llm.provider.id, model: llm.model, source: llm.source },
      stt,
      tts,
      ...(voiceMode === 'realtime' && realtime ? { realtime } : {}),
      ...(config.model.voiceMode === 'realtime' ? { requestedRealtimeProvider: requestedLive } : {}),
      simulated: simulatedParts.length > 0,
      simulatedParts,
      fallbacks,
    };
  }
}

export const LIVE_NAMES: Record<RealtimeProviderId, string> = { openai: 'OpenAI Realtime', google: 'Google Gemini Live' };
/** 'auto' order (documented in the scenario schema): Google Gemini Live first, then OpenAI. */
export const LIVE_AUTO_ORDER: RealtimeProviderId[] = ['google', 'openai'];

/**
 * Preferred live provider if configured, otherwise the other one (null when neither has a credential),
 * plus the next configured provider as the runtime backup.
 */
export function pickLiveProvider(
  requested: RealtimeProviderChoice,
  available: Record<RealtimeProviderId, unknown>,
): { provider: RealtimeProviderId | null; backup: RealtimeProviderId | null } {
  const order = requested === 'auto' ? LIVE_AUTO_ORDER : [requested, ...LIVE_AUTO_ORDER.filter((p) => p !== requested)];
  const [provider = null, backup = null] = order.filter((p) => !!available[p]);
  return { provider, backup };
}

function looksLikeGemini(model: string) {
  const m = model.toLowerCase();
  return m.startsWith('gemini') || m.startsWith('models/gemini');
}

/**
 * Model for the chosen live provider: the scenario override when it belongs to that provider (an override
 * written for the other provider is ignored after a fallback), then the workspace connection's
 * `realtimeModel`, then the server default.
 */
export function liveModel(provider: RealtimeProviderId, override: string, requested: RealtimeProviderChoice, connConfig?: Record<string, unknown>): string {
  const o = (override ?? '').trim();
  const fits = o && (provider === 'google' ? looksLikeGemini(o) : !looksLikeGemini(o));
  if (fits && (requested === 'auto' || requested === provider)) return o;
  const cfg = typeof connConfig?.realtimeModel === 'string' ? (connConfig.realtimeModel as string) : '';
  if (cfg) return cfg;
  return provider === 'google' ? env.GEMINI_LIVE_MODEL : env.OPENAI_REALTIME_MODEL;
}
