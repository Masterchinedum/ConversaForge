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

  describe('follow-up edits (Scenario Studio)', () => {
    const drafted = () => {
      const base = defaultScenarioConfig({ basics: { name: '' } });
      return apply(base, ruleBasedDraft('a 10-minute behavioral interview for a data analyst role', base, []).changes);
    };

    it('"make it 15 minutes" changes duration and dependent timing only', () => {
      const cfg = drafted();
      cfg.conversation.timedInstructions = [{ id: 't1', atSecond: 480, action: 'wrap_up', instruction: 'Start wrapping up' }];
      const r = ruleBasedDraft('Make it 15 minutes', cfg, [], { manualPaths: new Set() });
      const paths = r.changes.map((c) => c.path).sort();
      expect(paths).toEqual(
        ['basics.participantInstructions', 'basics.publicDescription', 'basics.targetDurationMinutes', 'conversation.ending', 'conversation.firstTurn', 'conversation.timedInstructions'].sort(),
      );
      const next = apply(cfg, r.changes);
      expect(next.basics.targetDurationMinutes).toBe(15);
      expect(next.conversation.firstTurn.text).toMatch(/15 minutes/);
      expect(next.conversation.timedInstructions[0]!.atSecond).toBe(720);
      expect(next.conversation.ending.maxDurationMinutes).toBeGreaterThanOrEqual(15);
      expect(validateScenarioForPublish(next).issues.filter((i) => i.severity === 'error')).toEqual([]);
      expect(r.reply).toMatch(/Everything else is unchanged/);
    });

    it('keeps the creator’s wording and says so', () => {
      const cfg = drafted();
      const r = ruleBasedDraft('Make it 15 minutes', cfg, [], { manualPaths: new Set(['basics.participantInstructions']) });
      expect(r.changes.map((c) => c.path)).not.toContain('basics.participantInstructions');
      expect(r.reply).toMatch(/Participant instructions still mentions 10 minutes/);
    });

    it('appends an agenda topic instead of regenerating the agenda, and does not change the type', () => {
      const cfg = drafted();
      const r = ruleBasedDraft('Also ask about their experience with SQL and dashboards', cfg, [], { manualPaths: new Set() });
      expect(r.changes.map((c) => c.path)).toEqual(['conversation.agenda']);
      const agenda = r.changes[0]!.value as ScenarioConfig['conversation']['agenda'];
      expect(agenda.length).toBe(cfg.conversation.agenda.length + 1);
      expect(agenda.slice(0, -2)).toEqual(cfg.conversation.agenda.slice(0, -1));
      expect(agenda.some((a) => /SQL and dashboards/.test(a.topic))).toBe(true);
    });

    it('renames, switches to fixed questions only on request, and keeps adaptive by default', () => {
      const cfg = drafted();
      expect(cfg.conversation.strategy).toBe('adaptive');
      expect(ruleBasedDraft('Call it "Analyst screen"', cfg, []).changes).toEqual([expect.objectContaining({ path: 'basics.name', value: 'Analyst screen' })]);
      const fixed = ruleBasedDraft('Use a fixed set of questions asked verbatim', cfg, []);
      const next = apply(cfg, fixed.changes);
      expect(next.conversation.strategy).toBe('fixed_questions');
      expect(validateScenarioForPublish(next).issues.filter((i) => i.severity === 'error')).toEqual([]);
    });

    it('enables supported tools and reports unsupported capabilities without faking them', () => {
      const cfg = drafted();
      const r = ruleBasedDraft('Add a timer and let them upload their resume. Also share their screen and send them an email afterwards.', cfg, []);
      const tools = r.changes.find((c) => c.path === 'tools')!.value as ScenarioConfig['tools'];
      expect(tools.enabled.map((t) => t.toolId)).toEqual(expect.arrayContaining(['end_session', 'timer', 'document_upload']));
      expect(r.unsupported.map((u) => u.request)).toEqual(['See or capture the participant’s screen', 'Send emails or messages']);
      expect(ruleBasedDraft('Add a timer', cfg, ['tools']).changes).toEqual([]);
    });

    it('reads the role from "for a … role" and treats "ask about …" as an agenda topic', () => {
      const r = ruleBasedDraft('A 20-minute behavioral interview for a senior product manager role. Ask about stakeholder management.', defaultScenarioConfig(), []);
      const get = (p: string) => r.changes.find((c) => c.path === p)!.value;
      expect(get('basics.name')).toBe('Behavioral interview for the senior product manager role');
      expect((get('conversation.agenda') as ScenarioConfig['conversation']['agenda']).map((a) => a.topic)).toContain('Stakeholder management');
    });

    it('asks open questions when a first brief leaves things out', () => {
      const r = ruleBasedDraft('something to practice with', defaultScenarioConfig(), []);
      expect(r.questions.length).toBeGreaterThan(0);
    });
  });
});
