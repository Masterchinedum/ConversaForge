import { Injectable } from '@nestjs/common';
import type { Channel, ScenarioConfig, SttProviderId, TtsProviderId } from '@cf/shared';
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
    opts: { channel: Channel; workspaceSettings?: Record<string, unknown> },
  ): Promise<ProviderInfo> {
    let llm: ResolvedLlm;
    try {
      llm = await this.resolveLlm(workspaceId, config);
    } catch (e) {
      if (e instanceof LlmUnavailableError) throw Errors.unavailable(e.message, { missing: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' });
      throw e;
    }
    if (llm.simulated && opts.workspaceSettings?.allowSimulator === false && config.model.llmProvider !== 'simulator') {
      throw Errors.unavailable(
        'No AI provider is configured for this workspace and the local simulator is disabled. Add an Anthropic or OpenAI key.',
        { missing: 'ANTHROPIC_API_KEY or OPENAI_API_KEY' },
      );
    }

    const fallbacks: string[] = [];
    const openai = !!(await this.llm.providerSecret(workspaceId, 'openai'));
    const deepgram = !!(await this.llm.providerSecret(workspaceId, 'deepgram'));
    const elevenlabs = !!(await this.llm.providerSecret(workspaceId, 'elevenlabs'));
    const isPhone = opts.channel === 'PHONE_INBOUND' || opts.channel === 'PHONE_OUTBOUND' || opts.channel === 'MEETING';

    let voiceMode = config.model.voiceMode;
    if (voiceMode === 'realtime') {
      if (!openai) {
        voiceMode = 'pipeline';
        fallbacks.push('OpenAI Realtime was requested but no OpenAI key is configured (OPENAI_API_KEY or a workspace OpenAI connection); using the speech pipeline instead.');
      } else if (isPhone) {
        voiceMode = 'pipeline';
        fallbacks.push('Realtime (WebRTC) voice is browser-only; phone/meeting channels use the speech pipeline.');
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
      ...(voiceMode === 'realtime'
        ? { realtime: { provider: 'openai' as const, model: config.model.realtimeModel || env.OPENAI_REALTIME_MODEL } }
        : {}),
      simulated: simulatedParts.length > 0,
      simulatedParts,
      fallbacks,
    };
  }
}
