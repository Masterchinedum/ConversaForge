import { Injectable, Logger } from '@nestjs/common';
import type { Session } from '@prisma/client';
import { substituteVariables, type ClientRuntimeConfig, type ScenarioConfig } from '@cf/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { StorageService } from '../../common/storage/storage.service';
import type { ConsentRecord, ProviderInfo } from './runtime.types';
import { ToolRegistry } from './tools/tool-registry';

/** Builds the ClientRuntimeConfig the participant UI needs (sent in `welcome` and the bootstrap GET). */
@Injectable()
export class ClientConfigService {
  private readonly logger = new Logger('ClientConfig');

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly tools: ToolRegistry,
  ) {}

  async build(session: Session, config: ScenarioConfig): Promise<ClientRuntimeConfig> {
    const pi = (session.providerInfo ?? {}) as unknown as Partial<ProviderInfo>;
    const consent = (session.consent ?? {}) as Partial<ConsentRecord>;
    const variables = (session.variables ?? {}) as Record<string, string>;
    const tt = config.conversation.turnTaking;
    return {
      voiceMode: pi.voiceMode ?? 'pipeline',
      stt: pi.stt ?? config.model.sttProvider,
      tts: pi.tts ?? config.model.ttsProvider,
      language: config.basics.language,
      voice: { provider: pi.tts ?? config.persona.voice.provider, voiceId: config.persona.voice.voiceId, speed: config.persona.voice.speed },
      persona: {
        name: config.persona.name,
        role: config.persona.role,
        avatar: {
          kind: config.persona.avatar.kind,
          ...(config.persona.avatar.imageUrl ? { imageUrl: config.persona.avatar.imageUrl } : {}),
          ...(config.persona.avatar.accentColor ? { accentColor: config.persona.avatar.accentColor } : {}),
        },
      },
      participantInstructions: substituteVariables(config.basics.participantInstructions, variables),
      turnTaking: {
        mode: tt.mode,
        endOfTurnSilenceMs: tt.endOfTurnSilenceMs,
        thinkingPauseGraceMs: tt.thinkingPauseGraceMs,
        silenceCheckInMs: tt.silenceCheckInMs,
        allowBargeIn: tt.allowBargeIn,
      },
      audio: { ...config.audio },
      recording: {
        audio: config.recording.audio && consent.recordAudio === true,
        video: config.recording.video && consent.recordVideo === true,
      },
      ui: {
        showCaptions: config.channels.browser.showCaptions,
        allowTextFallback: config.channels.browser.allowTextFallback,
        showArtifactPanel: config.channels.browser.showArtifactPanel,
      },
      allowParticipantEnd: config.conversation.ending.allowParticipantEnd,
      participantTools: this.tools.participantTools(config),
      simulated: !!pi.simulated,
      simulatedParts: pi.simulatedParts ?? [],
      ...(pi.voiceMode === 'realtime' && pi.realtime ? { realtime: pi.realtime } : {}),
      branding: await this.branding(session.workspaceId),
    };
  }

  async branding(workspaceId: string): Promise<ClientRuntimeConfig['branding']> {
    const b = await this.prisma.workspaceBranding.findUnique({ where: { workspaceId } });
    if (!b) return undefined;
    let logoUrl = b.logoUrl ?? undefined;
    if (b.logoAssetId) {
      const asset = await this.prisma.mediaAsset.findFirst({ where: { id: b.logoAssetId, workspaceId, deletedAt: null, status: 'READY' } });
      if (asset) {
        try {
          logoUrl = await this.storage.signedUrl(asset, 3600);
        } catch (e) {
          this.logger.warn(`logo url failed: ${(e as Error).message}`);
        }
      }
    }
    return {
      ...(b.displayName ? { displayName: b.displayName } : {}),
      ...(logoUrl ? { logoUrl } : {}),
      ...(b.primaryColor ? { primaryColor: b.primaryColor } : {}),
      hidePoweredBy: b.hidePoweredBy,
    };
  }
}
