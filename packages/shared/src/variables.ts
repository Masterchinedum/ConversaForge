import type { RuntimeVariable } from './scenario-config';
import { PLACEHOLDER_RE } from './scenario-config';
import { testPattern } from './safe-regex';

/**
 * Runtime variable handling. Values come from untrusted sources (share-link prefills, embed init,
 * API callers, participants). They are:
 *  1. accepted only for keys on the scenario's explicit allowlist,
 *  2. sanitized (control chars stripped, braces/backticks/angle brackets removed, whitespace collapsed,
 *     length-capped, optionally pattern-constrained),
 *  3. substituted only into templated fields, and presented to the model as quoted data.
 */

export interface VariableResolution {
  values: Record<string, string>;
  errors: Array<{ key: string; message: string }>;
  /** Keys that were supplied but are not on the allowlist (dropped). */
  rejectedKeys: string[];
}

const MAX_PATTERN_INPUT = 2000;

export function sanitizeVariableValue(raw: unknown, maxLength: number): string {
  let s = typeof raw === 'string' ? raw : raw == null ? '' : String(raw);
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ');
  s = s.replace(/[{}<>`]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > maxLength) s = s.slice(0, maxLength).trim();
  return s;
}

export function resolveVariables(
  allowlist: RuntimeVariable[],
  ...sources: Array<Record<string, unknown> | null | undefined>
): VariableResolution {
  const errors: VariableResolution['errors'] = [];
  const rejected = new Set<string>();
  const values: Record<string, string> = {};
  const allowed = new Map(allowlist.map((v) => [v.key, v]));

  // Later sources override earlier ones (e.g. defaults < link prefill < embed init).
  const merged: Record<string, unknown> = {};
  for (const src of sources) {
    if (!src || typeof src !== 'object') continue;
    for (const [k, v] of Object.entries(src)) {
      if (!allowed.has(k)) {
        rejected.add(k);
        continue;
      }
      if (v !== undefined && v !== null && v !== '') merged[k] = v;
    }
  }

  for (const def of allowlist) {
    const raw = merged[def.key] ?? def.defaultValue;
    const value = sanitizeVariableValue(raw, def.maxLength);
    if (!value) {
      if (def.required) errors.push({ key: def.key, message: `${def.label || def.key} is required` });
      continue;
    }
    if (def.pattern) {
      let re: RegExp | null = null;
      try {
        re = new RegExp(`^(?:${def.pattern})$`, 'u');
      } catch {
        errors.push({ key: def.key, message: 'Variable pattern is invalid' });
        continue;
      }
      // testPattern uses the server-installed, time-bounded tester (catastrophic backtracking → invalid).
      if (value.length > MAX_PATTERN_INPUT || !testPattern(re, value)) {
        errors.push({ key: def.key, message: `${def.label || def.key} has an invalid format` });
        continue;
      }
    }
    values[def.key] = value;
  }
  return { values, errors, rejectedKeys: [...rejected] };
}

/**
 * Replace {{key}} placeholders with sanitized values. Unknown keys are left as an inert marker
 * rather than leaking template syntax to the model.
 */
export function substituteVariables(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER_RE, (_m, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key]! : '[not provided]',
  );
}
