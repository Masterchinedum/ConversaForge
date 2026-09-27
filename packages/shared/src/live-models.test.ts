import { describe, expect, it } from 'vitest';
import { LLM_PROVIDERS, REALTIME_PROVIDERS, ScenarioConfigSchema, defaultScenarioConfig, validateScenarioForPublish } from './scenario-config';
import { SCENARIO_TEMPLATES } from './templates';

describe('live speech-to-speech model config', () => {
  it('defaults to live voice with automatic provider choice; Google is a text LLM option', () => {
    const c = defaultScenarioConfig();
    expect(c.model.voiceMode).toBe('realtime');
    expect(c.model.realtimeProvider).toBe('auto');
    expect(REALTIME_PROVIDERS).toEqual(['auto', 'google', 'openai']);
    expect(LLM_PROVIDERS).toContain('google');
  });

  it('keeps stored configs that name a provider explicitly (backward compatible)', () => {
    const old = ScenarioConfigSchema.parse({ model: { voiceMode: 'pipeline', realtimeProvider: 'openai', llmProvider: 'openai' } });
    expect(old.model).toMatchObject({ voiceMode: 'pipeline', realtimeProvider: 'openai', llmProvider: 'openai' });
    expect(ScenarioConfigSchema.parse({ model: { realtimeProvider: 'google', llmProvider: 'google' } }).model.realtimeProvider).toBe('google');
    expect(ScenarioConfigSchema.safeParse({ model: { realtimeProvider: 'azure' } }).success).toBe(false);
  });

  it('warns about a live model override that does not match the chosen provider, and about phone + live voice', () => {
    const t = SCENARIO_TEMPLATES[0]!;
    const base = t.config as any;
    const mismatch = validateScenarioForPublish({ ...base, model: { ...base.model, voiceMode: 'realtime', realtimeProvider: 'openai', realtimeModel: 'gemini-2.5-flash-native-audio-latest' } });
    expect(mismatch.issues.some((i) => i.path === 'model.realtimeModel' && i.severity === 'warning')).toBe(true);
    const phone = validateScenarioForPublish({ ...base, model: { ...base.model, voiceMode: 'realtime' }, channels: { ...base.channels, phone: { ...base.channels?.phone, enabled: true } } });
    expect(phone.issues.some((i) => i.path === 'model.voiceMode' && i.severity === 'warning')).toBe(true);
  });

  it('every template still parses and publishes', () => {
    for (const t of SCENARIO_TEMPLATES) expect(validateScenarioForPublish(t.config).ok).toBe(true);
  });
});
