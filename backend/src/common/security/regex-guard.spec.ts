import { resolveVariables } from '@cf/shared';
import { boundedRegexTest } from './regex-guard';

describe('regex guard (ReDoS)', () => {
  it('matches normally within budget', () => {
    expect(boundedRegexTest(/^\d{3}$/, '123')).toBe(true);
    expect(boundedRegexTest(/^\d{3}$/, '12a')).toBe(false);
  });

  it('interrupts catastrophic backtracking instead of blocking the event loop', () => {
    const started = Date.now();
    expect(() => boundedRegexTest(new RegExp('^(?:(a+)+)$', 'u'), `${'a'.repeat(40)}!`, 30)).toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a runtime variable with an evil pattern (e.g. stored before validation existed) fails closed, fast', () => {
    const started = Date.now();
    const r = resolveVariables([{ key: 'code', label: 'Code', description: '', required: false, maxLength: 2000, pattern: '(a+)+' }], { code: `${'a'.repeat(60)}!` });
    expect(r.errors.map((e) => e.key)).toEqual(['code']);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
