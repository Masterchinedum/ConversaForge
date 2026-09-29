import { createServer, type Server } from 'node:http';
import { defaultScenarioConfig, type ScenarioConfig } from '@cf/shared';
import { ProviderResolverService, liveModel, pickLiveProvider } from './provider-resolver.service';
import { GEMINI_TOKEN, RealtimeService, geminiVoice } from './realtime.service';

/**
 * Live speech-to-speech providers (unit): Gemini Live ephemeral-token minting against a local mock of the
 * Gemini API (real @google/genai SDK → GEMINI_BASE_URL), and the resolver's provider choice + fallbacks.
 */

function cfg(model: Partial<ScenarioConfig['model']> = {}, extra: Record<string, unknown> = {}): ScenarioConfig {
  const base = defaultScenarioConfig({ basics: { name: 'Interview', language: 'en-US' }, persona: { role: 'Interviewer' }, ...extra } as any);
  return { ...base, model: { ...base.model, ...model } };
}

function fakeLlm(secrets: Record<string, { secret: string; config?: Record<string, unknown>; source?: 'workspace' | 'environment' } | null>) {
  return {
    resolve: async () => ({ provider: { id: 'simulator', simulated: true }, model: 'local-simulator', simulated: true, source: 'simulator' }),
    providerSecret: async (_ws: string, provider: string, capability?: string) => {
      const s = secrets[provider];
      if (!s) return null;
      const caps = s.config?.capabilities as string[] | undefined;
      if (capability && caps && !caps.includes(capability)) return null;
      return { secret: s.secret, config: s.config ?? {}, source: s.source ?? 'workspace' };
    },
  } as any;
}

describe('Gemini Live token minting (mock Gemini API)', () => {
  let server: Server;
  const requests: Array<{ url: string; key: string | undefined; body: any }> = [];
  const prevBase = process.env.GEMINI_BASE_URL;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        requests.push({ url: req.url ?? '', key: req.headers['x-goog-api-key'] as string | undefined, body: JSON.parse(data || '{}') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'auth_tokens/ephemeral-abc123' }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => {
    server.close();
    if (prevBase === undefined) delete process.env.GEMINI_BASE_URL;
    else process.env.GEMINI_BASE_URL = prevBase;
  });
  beforeEach(() => (requests.length = 0));

  const tools = [
    { name: 'update_progress', description: 'progress', inputSchema: { type: 'object', properties: { currentTopicId: { type: 'string' } } } },
    { name: 'end_session', description: 'end', inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] } },
    { name: 'fn_lookup_order', description: 'custom', inputSchema: { type: 'object', properties: {} } },
  ];

  it('mints a single-use, short-lived token whose setup (instructions, tools, voice, transcription) is fully locked', async () => {
    const svc = new RealtimeService(fakeLlm({ google: { secret: 'AIza-REAL-KEY-never-leaves' } }));
    const config = cfg({ realtimeProvider: 'google' }, { persona: { role: 'Interviewer', voice: { provider: 'browser', voiceId: 'kore', speed: 1 } } });
    const before = Date.now();
    const creds: any = await svc.mint({ workspaceId: 'ws', provider: 'google', model: '', instructions: '<behavior_policy>x</behavior_policy>\n<conversation_state>y</conversation_state>', tools, config });

    expect(requests).toHaveLength(1);
    const r = requests[0]!;
    expect(r.url).toBe('/v1alpha/auth_tokens');
    expect(r.key).toBe('AIza-REAL-KEY-never-leaves');
    const b = r.body;
    expect(b.uses).toBe(1);
    expect(b.fieldMask).toBeUndefined(); // no mask → the whole setup is locked to these values
    const exp = Date.parse(b.expireTime) - before;
    const start = Date.parse(b.newSessionExpireTime) - before;
    expect(exp).toBeGreaterThan(GEMINI_TOKEN.expireSeconds * 1000 - 5000);
    expect(exp).toBeLessThanOrEqual(GEMINI_TOKEN.expireSeconds * 1000 + 5000);
    expect(start).toBeLessThanOrEqual(2 * 60_000 + 5000);
    const setup = b.bidiGenerateContentSetup;
    expect(setup.model).toBe('models/gemini-3.8-live');
    expect(setup.systemInstruction.parts[0].text).toContain('<behavior_policy>');
    expect(setup.systemInstruction.parts[0].text).toContain('<conversation_state>');
    expect(setup.tools[0].functionDeclarations.map((f: any) => f.name)).toEqual(['update_progress', 'end_session', 'fn_lookup_order']);
    expect(setup.tools[0].functionDeclarations[1].parametersJsonSchema.required).toEqual(['reason']);
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    // gemini-3.8-live is not a native-audio model name, so the scenario language is sent too.
    expect(setup.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }, languageCode: config.basics.language });
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.realtimeInputConfig).toMatchObject({
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', endOfSpeechSensitivity: 'END_SENSITIVITY_LOW', silenceDurationMs: 1200 },
    });
    expect(setup.sessionResumption).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });

    expect(creds).toMatchObject({
      provider: 'google',
      model: 'gemini-3.8-live',
      token: 'auth_tokens/ephemeral-abc123',
      apiVersion: 'v1alpha',
      voice: 'Kore',
      resumed: false,
      connectConfig: { responseModalities: ['AUDIO'], inputAudioTranscription: {}, outputAudioTranscription: {}, sessionResumption: {} },
      audio: { inputMimeType: 'audio/pcm;rate=16000', outputSampleRate: 24000 },
    });
    // SECURITY: neither the real key nor the prompt/tools reach the browser.
    const json = JSON.stringify(creds);
    expect(json).not.toContain('AIza-REAL-KEY');
    expect(json).not.toContain('behavior_policy');
    expect(json).not.toContain('update_progress');
  });

  it('resumes with a handle (locked into the new token), honours no-barge-in and half-cascade language codes', async () => {
    const svc = new RealtimeService(fakeLlm({ google: { secret: 'k', config: { voice: 'Puck' } } }));
    const config = cfg({}, { conversation: { turnTaking: { allowBargeIn: false, endOfTurnSilenceMs: 4500 } } });
    const creds: any = await svc.mint({ workspaceId: 'ws', provider: 'google', model: 'gemini-live-2.5-flash-preview', instructions: 'I', tools: [], config, resumeHandle: 'handle-XYZ' });
    const setup = requests[0]!.body.bidiGenerateContentSetup;
    expect(setup.model).toBe('models/gemini-live-2.5-flash-preview');
    expect(setup.sessionResumption).toEqual({ handle: 'handle-XYZ' });
    expect(setup.realtimeInputConfig.activityHandling).toBe('NO_INTERRUPTION');
    expect(setup.realtimeInputConfig.automaticActivityDetection.silenceDurationMs).toBe(3000);
    expect(setup.generationConfig.speechConfig).toEqual({ voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Puck' } }, languageCode: 'en-US' });
    expect(setup.tools).toBeUndefined();
    expect(creds).toMatchObject({ resumed: true, connectConfig: { sessionResumption: { handle: 'handle-XYZ' } } });
  });

  it('503 when no Google credential (or the connection has live voice unchecked)', async () => {
    const svc = new RealtimeService(fakeLlm({ google: { secret: 'k', config: { capabilities: ['LLM'] } } }));
    await expect(svc.mint({ workspaceId: 'ws', provider: 'google', model: '', instructions: 'I', tools: [], config: cfg() })).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(0);
  });

  it('geminiVoice matches documented prebuilt voices case-insensitively, ignores others', () => {
    expect(geminiVoice('alloy', 'zephyr')).toBe('Zephyr');
    expect(geminiVoice('nope')).toBeUndefined();
  });
});

describe('ProviderResolverService: live provider choice and fallbacks', () => {
  const resolve = (secrets: Parameters<typeof fakeLlm>[0], model: Partial<ScenarioConfig['model']>, channel: any = 'BROWSER') =>
    new ProviderResolverService(fakeLlm(secrets)).resolve('ws', cfg(model), { channel });

  it('defaults: voiceMode realtime + provider auto', () => {
    const c = defaultScenarioConfig();
    expect(c.model.voiceMode).toBe('realtime');
    expect(c.model.realtimeProvider).toBe('auto');
  });

  it('auto with no live credential → pipeline with a clear reason (simulator still works)', async () => {
    const pi = await resolve({}, {});
    expect(pi.voiceMode).toBe('pipeline');
    expect(pi.requestedVoiceMode).toBe('realtime');
    expect(pi.realtime).toBeUndefined();
    expect(pi.fallbacks.join(' ')).toMatch(/Live voice unavailable.*OPENAI_API_KEY or GEMINI_API_KEY/);
    expect(pi.simulatedParts).toContain('llm');
  });

  it('auto picks Gemini Live first, with OpenAI as the backup', async () => {
    const both = await resolve({ openai: { secret: 'o', source: 'environment' }, google: { secret: 'g', source: 'environment' } }, {});
    expect(both.realtime).toEqual({
      provider: 'google',
      model: 'gemini-3.8-live',
      source: 'environment',
      backup: { provider: 'openai', model: 'gpt-realtime-2.1', source: 'environment' },
    });
    const g = await resolve({ google: { secret: 'g', source: 'environment' } }, {});
    expect(g.voiceMode).toBe('realtime');
    expect(g.realtime).toEqual({ provider: 'google', model: 'gemini-3.8-live', source: 'environment' });
    expect(g.fallbacks).toEqual([]);
    const o = await resolve({ openai: { secret: 'o', source: 'environment' } }, {});
    expect(o.realtime).toEqual({ provider: 'openai', model: 'gpt-realtime-2.1', source: 'environment' });
  });

  it('preferred provider missing → the other one, recorded as a fallback', async () => {
    const a = await resolve({ google: { secret: 'g' } }, { realtimeProvider: 'openai', realtimeModel: 'gpt-realtime-mini' });
    expect(a.realtime).toMatchObject({ provider: 'google', model: 'gemini-3.8-live' }); // OpenAI override not applied to Gemini
    expect(a.fallbacks[0]).toMatch(/OpenAI Realtime was requested.*OPENAI_API_KEY.*using Google Gemini Live instead/);
    const b = await resolve({ openai: { secret: 'o' } }, { realtimeProvider: 'google' });
    expect(b.realtime?.provider).toBe('openai');
    expect(b.fallbacks[0]).toMatch(/Google Gemini Live was requested.*GEMINI_API_KEY.*using OpenAI Realtime instead/);
    const c = await resolve({}, { realtimeProvider: 'google' });
    expect(c.voiceMode).toBe('pipeline');
    expect(c.fallbacks[0]).toMatch(/Google Gemini Live was requested.*speech pipeline/);
  });

  it('explicit provider + model override; connection capability unchecked → not used for live voice', async () => {
    const pi = await resolve({ openai: { secret: 'o' }, google: { secret: 'g' } }, { realtimeProvider: 'google', realtimeModel: 'gemini-live-2.5-flash-preview' });
    expect(pi.realtime).toMatchObject({ provider: 'google', model: 'gemini-live-2.5-flash-preview' });
    const noCap = await resolve({ google: { secret: 'g', config: { capabilities: ['LLM'] } } }, {});
    expect(noCap.voiceMode).toBe('pipeline');
  });

  it('phone/meeting channels always use the pipeline', async () => {
    const pi = await resolve({ google: { secret: 'g' } }, {}, 'PHONE_INBOUND');
    expect(pi.voiceMode).toBe('pipeline');
    expect(pi.fallbacks[0]).toMatch(/browser only/);
    expect((await resolve({ google: { secret: 'g' } }, {}, 'MEETING')).voiceMode).toBe('pipeline');
  });

  it('meeting agent bots (audio in the bot page) get live voice like the browser', async () => {
    const pi = await new ProviderResolverService(fakeLlm({ google: { secret: 'g' } })).resolve('ws', cfg({}), { channel: 'MEETING', mediaInBrowser: true });
    expect(pi.voiceMode).toBe('realtime');
    expect(pi.realtime?.provider).toBe('google');
  });

  it('pickLiveProvider / liveModel helpers', () => {
    expect(pickLiveProvider('auto', { openai: null, google: {} })).toEqual({ provider: 'google', backup: null });
    expect(pickLiveProvider('auto', { openai: {}, google: {} })).toEqual({ provider: 'google', backup: 'openai' });
    expect(pickLiveProvider('openai', { openai: {}, google: {} })).toEqual({ provider: 'openai', backup: 'google' });
    expect(pickLiveProvider('google', { openai: {}, google: {} }).provider).toBe('google');
    expect(pickLiveProvider('openai', { openai: null, google: null }).provider).toBeNull();
    expect(liveModel('google', '', 'auto', { realtimeModel: 'gemini-x-live' })).toBe('gemini-x-live');
    expect(liveModel('google', 'gemini-y', 'auto')).toBe('gemini-y');
    expect(liveModel('openai', 'gemini-y', 'auto')).toBe('gpt-realtime-2.1');
  });
});
