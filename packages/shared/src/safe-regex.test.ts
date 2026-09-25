import { describe, expect, it } from 'vitest';
import { regexPatternRisk, resolveVariables, setPatternTester, validateScenarioForPublish, defaultScenarioConfig } from './index';

describe('regexPatternRisk (ReDoS guard)', () => {
  it.each(['(a+)+', '(a*)*b', '(\\w+\\s?)*$', '(a|aa)+', '(x|y)*z', '(a{1,5}){2,}', '((ab)+c)+', '(a)\\1', '(?<n>a)\\k<n>', '\\d*\\d*\\d*\\d*\\d*x'])(
    'rejects %s',
    (p) => expect(regexPatternRisk(p)).not.toBeNull(),
  );
  it.each(['[A-Z]{3}', '\\d{4}-\\d{2}', '[^@\\s]+@[^@\\s]+\\.[a-z]{2,}', '(https?://)?[a-z.]+', '[(+*)]+', 'a\\+b+', '(ab)?c+'])('accepts %s', (p) =>
    expect(regexPatternRisk(p)).toBeNull(),
  );

  it('scenario validation reports risky variable patterns as errors', () => {
    const cfg = defaultScenarioConfig({ variables: { allowlist: [{ key: 'code', label: 'Code', maxLength: 100, pattern: '(a+)+' }] } } as any);
    const { issues } = validateScenarioForPublish(cfg);
    expect(issues.some((i) => i.path === 'variables.allowlist.0.pattern' && i.severity === 'error')).toBe(true);
  });

  it('resolveVariables treats a tester failure (e.g. time budget exceeded) as an invalid value', () => {
    setPatternTester(() => {
      throw new Error('timeout');
    });
    try {
      const r = resolveVariables([{ key: 'code', label: 'Code', description: '', required: false, maxLength: 50, pattern: '[a-z]+' }], { code: 'abc' });
      expect(r.errors.map((e) => e.key)).toEqual(['code']);
    } finally {
      setPatternTester((re, v) => re.test(v));
    }
  });
});
