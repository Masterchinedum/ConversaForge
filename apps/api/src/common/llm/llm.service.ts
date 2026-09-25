import { Global, Injectable, Logger, Module } from '@nestjs/common';
import type { LlmProviderId } from '@cf/shared';
import { env } from '../../config/env';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { AnthropicProvider } from './anthropic.provider';
import { OpenAIProvider } from './openai.provider';
import { SimulatorProvider } from './simulator.provider';
import { LlmUnavailableError, type LlmPurpose, type ResolvedLlm } from './llm.types';

/**
 * Resolves which language model to use for a workspace + purpose:
 *   1. workspace ProviderConnection (BYO key, encrypted at rest), preferred provider first
 *   2. server environment key (ANTHROPIC_API_KEY / OPENAI_API_KEY)
 *   3. local development simulator (only when ALLOW_SIMULATOR is not "false")
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger('LLM');
  private readonly simulator = new SimulatorProvider();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
  ) {}

  async resolve(workspaceId: string, purpose: LlmPurpose, preferred?: LlmProviderId | null, modelOverride?: string | null): Promise<ResolvedLlm> {
    if (preferred === 'simulator') return this.simulatorResolved();
    const order: Array<'anthropic' | 'openai'> =
      preferred === 'openai' ? ['openai', 'anthropic'] : ['anthropic', 'openai'];

    const connections = await this.prisma.providerConnection.findMany({
      where: { workspaceId, kind: 'LLM', status: 'ACTIVE', revokedAt: null, provider: { in: order } },
      orderBy: { createdAt: 'desc' },
    });

    for (const provider of order) {
      const conn = connections.find((c) => c.provider === provider);
      let key: string | undefined;
      let source: ResolvedLlm['source'] = 'environment';
      if (conn) {
        try {
          key = this.crypto.decrypt(conn.encryptedSecret);
          source = 'workspace';
        } catch (e: any) {
          this.logger.error(`Could not decrypt provider connection ${conn.id}: ${e?.message}`);
        }
      }
      if (!key) key = provider === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY;
      if (!key) continue;
      const cfgModel = (conn?.config as any)?.[purpose === 'live' ? 'liveModel' : 'analysisModel'] as string | undefined;
      const model = (preferred === provider && modelOverride) || cfgModel || this.defaultModel(provider, purpose);
      const instance = provider === 'anthropic' ? new AnthropicProvider(key) : new OpenAIProvider(key);
      return { provider: instance, model, simulated: false, source };
    }

    if (env.ALLOW_SIMULATOR) return this.simulatorResolved();
    throw new LlmUnavailableError(
      'No AI provider is configured. Add an Anthropic or OpenAI key in Settings → AI providers, or set ANTHROPIC_API_KEY on the server.',
    );
  }

  private simulatorResolved(): ResolvedLlm {
    return { provider: this.simulator, model: 'local-simulator', simulated: true, source: 'simulator' };
  }

  defaultModel(provider: 'anthropic' | 'openai', purpose: LlmPurpose): string {
    if (provider === 'anthropic') return purpose === 'live' ? env.ANTHROPIC_LIVE_MODEL : env.ANTHROPIC_ANALYSIS_MODEL;
    return purpose === 'live' ? env.OPENAI_LIVE_MODEL : env.OPENAI_ANALYSIS_MODEL;
  }

  /** Which real providers are available (for UI status pages). */
  async availability(workspaceId: string) {
    const conns = await this.prisma.providerConnection.findMany({
      where: { workspaceId, status: 'ACTIVE', revokedAt: null },
      select: { provider: true, kind: true },
    });
    const has = (p: string) => conns.some((c) => c.provider === p);
    return {
      anthropic: has('anthropic') || !!env.ANTHROPIC_API_KEY,
      openai: has('openai') || !!env.OPENAI_API_KEY,
      deepgram: has('deepgram') || !!env.DEEPGRAM_API_KEY,
      elevenlabs: has('elevenlabs') || !!env.ELEVENLABS_API_KEY,
      twilio: has('twilio') || !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN),
      recall: has('recall') || !!env.RECALL_API_KEY,
      simulatorAllowed: env.ALLOW_SIMULATOR,
    };
  }

  /** Decrypted secret for a non-LLM provider (openai realtime/tts/stt, deepgram, elevenlabs, twilio, recall). */
  async providerSecret(workspaceId: string, provider: string): Promise<{ secret: string; config: Record<string, unknown>; source: 'workspace' | 'environment' } | null> {
    const conn = await this.prisma.providerConnection.findFirst({
      where: { workspaceId, provider, status: 'ACTIVE', revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (conn) {
      try {
        let secret = this.crypto.decrypt(conn.encryptedSecret);
        const config = (conn.config as Record<string, unknown>) ?? {};
        // Workstream G stores Twilio credentials as JSON {accountSid, authToken}; expose the same
        // "sid:token" format as the environment fallback so consumers handle one shape.
        if (provider === 'twilio' && secret.startsWith('{')) {
          try {
            const j = JSON.parse(secret) as { accountSid?: string; authToken?: string };
            if (j.accountSid && j.authToken) secret = `${j.accountSid}:${j.authToken}`;
          } catch {
            /* keep raw */
          }
        }
        if (secret) return { secret, config, source: 'workspace' };
      } catch {
        /* fall through to env */
      }
    }
    const envMap: Record<string, string | undefined> = {
      openai: env.OPENAI_API_KEY,
      anthropic: env.ANTHROPIC_API_KEY,
      deepgram: env.DEEPGRAM_API_KEY,
      elevenlabs: env.ELEVENLABS_API_KEY,
      recall: env.RECALL_API_KEY,
      twilio: env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN ? `${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}` : undefined,
    };
    const s = envMap[provider];
    return s ? { secret: s, config: {}, source: 'environment' } : null;
  }
}

@Global()
@Module({ providers: [LlmService], exports: [LlmService] })
export class LlmModule {}
