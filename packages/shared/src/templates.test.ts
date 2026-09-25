import { describe, it, expect } from 'vitest';
import { SCENARIO_TEMPLATES } from './templates';
import { validateScenarioForPublish, findPlaceholders, templatedFields } from './scenario-config';
import { getToolDefinition } from './tools';

describe('built-in templates', () => {
  it('has unique keys and at least 8 templates', () => {
    const keys = SCENARIO_TEMPLATES.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBeGreaterThanOrEqual(8);
  });

  for (const t of SCENARIO_TEMPLATES) {
    describe(t.key, () => {
      const r = validateScenarioForPublish(t.config);
      it('passes publish validation with no errors', () => {
        expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
        expect(r.ok).toBe(true);
      });
      it('has an agenda and boundaries (no warnings for those)', () => {
        expect(r.issues.filter((i) => i.path === 'conversation.agenda' || i.path === 'instructions.boundaries')).toEqual([]);
      });
      it('only enables available tools', () => {
        for (const tool of r.config!.tools.enabled) {
          expect(getToolDefinition(tool.toolId)?.status).toBe('available');
        }
      });
      it('uses only allowlisted placeholders and no placeholders in public fields', () => {
        const allowed = new Set(r.config!.variables.allowlist.map((v) => v.key));
        for (const [, text] of templatedFields(r.config!)) for (const k of findPlaceholders(text)) expect(allowed.has(k)).toBe(true);
        expect(findPlaceholders(r.config!.basics.publicDescription)).toEqual([]);
        expect(findPlaceholders(r.config!.basics.name)).toEqual([]);
      });
    });
  }

  it('covers the required scenario kinds', () => {
    const cfgs = SCENARIO_TEMPLATES.map((t) => validateScenarioForPublish(t.config).config!);
    expect(cfgs.some((c) => c.tools.enabled.some((x) => x.toolId === 'whiteboard'))).toBe(true);
    expect(cfgs.some((c) => c.tools.enabled.some((x) => x.toolId === 'cards'))).toBe(true);
    expect(cfgs.some((c) => c.coach.enabled && c.memory.enabled)).toBe(true);
    for (const type of ['interview', 'sales_practice', 'negotiation', 'leadership', 'support', 'demo', 'coaching']) {
      expect(cfgs.some((c) => c.basics.type === type)).toBe(true);
    }
  });
});
