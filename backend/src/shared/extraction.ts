import type { ExtractionVariable } from './scenario-config';

/** Coerce and validate a model-proposed extraction value against the declared type. */
export function validateExtractionValue(
  def: Pick<ExtractionVariable, 'key' | 'type' | 'required' | 'enumValues'>,
  raw: unknown,
): { value: unknown; valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (raw === null || raw === undefined || raw === '') {
    if (def.required) errors.push('Required value was not found in the conversation');
    return { value: null, valid: !def.required, errors };
  }
  switch (def.type) {
    case 'text': {
      const v = typeof raw === 'string' ? raw.trim() : JSON.stringify(raw);
      if (def.enumValues?.length && !def.enumValues.includes(v)) errors.push(`Value must be one of: ${def.enumValues.join(', ')}`);
      return { value: v.slice(0, 5000), valid: errors.length === 0, errors };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw.replace(/[, _]/g, '')) : NaN;
      if (!Number.isFinite(n)) return { value: null, valid: false, errors: ['Not a number'] };
      return { value: n, valid: true, errors };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw, valid: true, errors };
      if (typeof raw === 'string') {
        const s = raw.trim().toLowerCase();
        if (['true', 'yes', 'y', '1'].includes(s)) return { value: true, valid: true, errors };
        if (['false', 'no', 'n', '0'].includes(s)) return { value: false, valid: true, errors };
      }
      return { value: null, valid: false, errors: ['Not a boolean'] };
    }
    case 'list': {
      const arr = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,;\n]/) : null;
      if (!arr) return { value: null, valid: false, errors: ['Not a list'] };
      const items = arr.map((x) => (typeof x === 'string' ? x.trim() : JSON.stringify(x))).filter(Boolean).slice(0, 100);
      if (def.enumValues?.length) {
        const bad = items.filter((i) => !def.enumValues!.includes(i));
        if (bad.length) errors.push(`Unexpected values: ${bad.join(', ')}`);
      }
      return { value: items, valid: errors.length === 0, errors };
    }
    case 'date': {
      const s = typeof raw === 'string' ? raw.trim() : String(raw);
      const iso = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(s);
      const d = new Date(s);
      if (!iso || Number.isNaN(d.getTime())) return { value: null, valid: false, errors: ['Not an ISO-8601 date (YYYY-MM-DD)'] };
      return { value: s.length === 10 ? s : d.toISOString(), valid: true, errors };
    }
  }
}
