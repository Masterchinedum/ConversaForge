import { defaultScenarioConfig, SCENARIO_TEMPLATES } from '@cf/shared';
import { exportScenarioConfig, importScenarioConfig, IMPORT_MAX_BYTES, parseConfigText, ScenarioImportError } from './scenario-io';
import { isPathLocked, isSafeConfigPath } from './scenario-utils';

describe('scenario YAML/JSON import (data only)', () => {
  const tpl = defaultScenarioConfig(SCENARIO_TEMPLATES[0]!.config);

  it('round-trips YAML and JSON exports', () => {
    const yaml = exportScenarioConfig(tpl, 'yaml', { name: 'x', source: 'draft' });
    expect(importScenarioConfig(yaml)).toEqual(tpl);
    const json = exportScenarioConfig(tpl, 'json', { name: 'x', source: 'draft' });
    expect(importScenarioConfig(json, 'json')).toEqual(tpl);
  });

  it('accepts an export envelope', () => {
    const text = JSON.stringify({ kind: 'conversaforge.scenario', config: { basics: { name: 'Env' } } });
    expect(importScenarioConfig(text).basics.name).toBe('Env');
  });

  it('rejects executable / language-specific YAML tags', () => {
    const payloads = [
      'basics:\n  name: !!js/function "function(){ return process.exit(1) }"\n',
      'basics:\n  name: !!js/undefined ""\n',
      'basics: !!python/object/apply:os.system ["id"]\n',
      'basics:\n  name: !<tag:yaml.org,2002:js/regexp> /x/\n',
      'basics:\n  name: !custom thing\n',
    ];
    for (const p of payloads) {
      expect(() => importScenarioConfig(p)).toThrow(ScenarioImportError);
    }
  });

  it('rejects YAML alias bombs (billion laughs)', () => {
    const bomb = [
      'a: &a ["x","x","x","x","x","x","x","x","x"]',
      'b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]',
      'c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]',
      'd: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]',
      'e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]',
      'f: &f [*e,*e,*e,*e,*e,*e,*e,*e,*e]',
      'g: [*f,*f,*f,*f,*f,*f,*f,*f,*f]',
    ].join('\n');
    expect(() => parseConfigText(bomb, 'yaml')).toThrow(/alias|parse/i);
  });

  it('rejects oversized input before parsing', () => {
    const big = `basics:\n  internalDescription: "${'a'.repeat(IMPORT_MAX_BYTES + 10)}"\n`;
    expect(() => importScenarioConfig(big)).toThrow(/too large/);
  });

  it('rejects schema-invalid values with field paths', () => {
    try {
      importScenarioConfig('rubric:\n  criteria:\n    - id: a\n      name: A\n      weight: "lots"\n');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ScenarioImportError);
      expect((e as ScenarioImportError).details[0]!.path).toBe('rubric.criteria.0.weight');
    }
  });

  it('rejects non-object documents, duplicate keys, deep nesting and merge keys', () => {
    expect(() => importScenarioConfig('- a\n- b\n')).toThrow(/mapping/);
    expect(() => importScenarioConfig('basics:\n  name: a\n  name: b\n')).toThrow(ScenarioImportError);
    expect(() => importScenarioConfig('['.repeat(5000) + ']'.repeat(5000), 'json')).toThrow(ScenarioImportError);
    const merged = importScenarioConfig('base: &b\n  name: Merged\nbasics:\n  <<: *b\n');
    expect(merged.basics.name).toBe(''); // "<<" is an ordinary (stripped) key, not a merge
  });

  it('never lets __proto__ reach objects', () => {
    const parsed = parseConfigText('{"__proto__": {"polluted": true}, "basics": {"name": "x", "constructor": {"a":1}}}', 'json') as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(false);
    expect(parsed.basics.constructor).toBe(Object); // own "constructor" key was dropped
    const y = parseConfigText('__proto__:\n  polluted: true\nbasics:\n  name: y\n', 'yaml') as any;
    expect(({} as any).polluted).toBeUndefined();
    expect(Object.keys(y)).toEqual(['basics']);
  });
});

describe('config path helpers', () => {
  it('accepts safe paths and rejects prototype paths / unknown roots', () => {
    expect(isSafeConfigPath('basics.name')).toBe(true);
    expect(isSafeConfigPath('conversation.agenda.0.topic')).toBe(true);
    expect(isSafeConfigPath('__proto__.polluted')).toBe(false);
    expect(isSafeConfigPath('basics.__proto__')).toBe(false);
    expect(isSafeConfigPath('basics.constructor.prototype')).toBe(false);
    expect(isSafeConfigPath('nope.name')).toBe(false);
    expect(isSafeConfigPath('')).toBe(false);
  });
  it('treats parent and child paths as locked', () => {
    expect(isPathLocked('rubric', ['rubric'])).toBe(true);
    expect(isPathLocked('conversation.agenda', ['conversation'])).toBe(true);
    expect(isPathLocked('conversation', ['conversation.agenda'])).toBe(true);
    expect(isPathLocked('conversation.firstTurn', ['conversation.agenda'])).toBe(false);
  });
});
