import { defaultScenarioConfig, SCENARIO_TEMPLATES, validateScenarioForPublish, setAtPath, type ScenarioConfig } from '@cf/shared';
import { detectMinutes, detectType, ruleBasedDraft } from './rule-drafter';

const apply = (c: ScenarioConfig, changes: Array<{ path: string; value: unknown }>) =>
  changes.reduce<ScenarioConfig>((acc, ch) => setAtPath(acc, ch.path, ch.value), c);

describe('rule-based drafter (simulator)', () => {
  it('does not repeat the duration in the generated description ("10-minute -minute")', () => {
    const { changes } = ruleBasedDraft('a 10-minute sales discovery call with a skeptical CFO of a logistics company', defaultScenarioConfig(), []);
    const desc = changes.find((c) => c.path === 'basics.publicDescription')!.value as string;
    expect(desc).toMatch(/^Practice a 10-minute sales discovery call/);
    expect(desc).not.toMatch(/minute -minute|-minute minute/);
  });

  it('parses type, duration and persona from a brief', () => {
    expect(detectType('a 15-minute sales discovery call with a skeptical CFO')).toBe('sales_practice');
    expect(detectType('mock system design interview')).toBe('interview');
    expect(detectType('negotiate a contract renewal')).toBe('negotiation');
    expect(detectMinutes('a 15-minute call')).toBe(15);
    expect(detectMinutes('20 min chat')).toBe(20);
    expect(detectMinutes('half an hour')).toBe(30);
    expect(detectMinutes('no time given')).toBeNull();
  });

  for (const brief of [
    'a 15-minute sales discovery call with a skeptical CFO about our analytics product',
    'a 30 minute behavioral interview for a product manager role',
    'a 10-minute de-escalation support call with an angry customer about a late delivery',
    'practice delivering difficult feedback to a defensive direct report',
    'a coaching session about active listening',
  ]) {
    it(`drafts a publishable scenario from: ${brief}`, () => {
      const base = defaultScenarioConfig({ basics: { name: '' } });
      const r = ruleBasedDraft(brief, base, []);
      const next = apply(base, r.changes);
      const v = validateScenarioForPublish(next);
      expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    });
  }

  it('only touches filled fields when targeted, and skips locked ones', () => {
    const tpl = defaultScenarioConfig(SCENARIO_TEMPLATES[0]!.config);
    const none = ruleBasedDraft('a 15-minute sales call', tpl, ['basics.targetDurationMinutes', 'conversation.ending', 'basics.type']);
    expect(none.changes.map((c) => c.path)).toEqual([]);
    const rubric = ruleBasedDraft('rewrite the rubric', tpl, []);
    expect(rubric.changes.map((c) => c.path)).toEqual(['rubric']);
    expect(ruleBasedDraft('rewrite the rubric', tpl, ['rubric']).changes).toEqual([]);
  });
});
