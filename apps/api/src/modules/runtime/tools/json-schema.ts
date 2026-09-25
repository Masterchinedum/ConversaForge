/**
 * Minimal JSON-Schema validator for tool arguments (the subset used by the tool catalog and custom
 * function schemas): type, properties, required, additionalProperties, enum, const, min/maxLength,
 * minimum/maximum, min/maxItems, items, pattern (length-capped). Unknown keywords are ignored.
 * Every model-issued tool call is validated before execution.
 */
export interface SchemaError {
  path: string;
  message: string;
}

type Schema = Record<string, any>;

const MAX_DEPTH = 12;

export function validateJsonSchema(schema: Schema, value: unknown): SchemaError[] {
  const errors: SchemaError[] = [];
  walk(schema, value, '$', errors, 0);
  return errors.slice(0, 20);
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function matchesType(expected: string, v: unknown): boolean {
  const t = typeOf(v);
  if (expected === 'number') return t === 'number' || t === 'integer';
  return t === expected;
}

function walk(schema: Schema, value: unknown, path: string, errors: SchemaError[], depth: number) {
  if (!schema || typeof schema !== 'object') return;
  if (depth > MAX_DEPTH) {
    errors.push({ path, message: 'Value is nested too deeply' });
    return;
  }
  if (schema.type) {
    const types: string[] = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push({ path, message: `Expected ${types.join(' or ')}, got ${typeOf(value)}` });
      return;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e: unknown) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push({ path, message: `Must be one of: ${schema.enum.map((e: unknown) => JSON.stringify(e)).join(', ')}` });
  }
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errors.push({ path, message: `Must equal ${JSON.stringify(schema.const)}` });
  }
  if (typeof value === 'string') {
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
      errors.push({ path, message: `Must be at most ${schema.maxLength} characters` });
    if (typeof schema.minLength === 'number' && value.length < schema.minLength)
      errors.push({ path, message: `Must be at least ${schema.minLength} characters` });
    if (typeof schema.pattern === 'string' && schema.pattern.length <= 200 && value.length <= 5000) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) errors.push({ path, message: 'Does not match the required pattern' });
      } catch {
        /* invalid pattern in schema: ignore */
      }
    }
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push({ path, message: `Must be >= ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push({ path, message: `Must be <= ${schema.maximum}` });
  }
  if (Array.isArray(value)) {
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
      errors.push({ path, message: `Must have at most ${schema.maxItems} items` });
    if (typeof schema.minItems === 'number' && value.length < schema.minItems)
      errors.push({ path, message: `Must have at least ${schema.minItems} items` });
    if (schema.items && typeof schema.items === 'object') {
      value.slice(0, 500).forEach((item, i) => walk(schema.items, item, `${path}[${i}]`, errors, depth + 1));
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const props: Record<string, Schema> = schema.properties ?? {};
    for (const key of schema.required ?? []) {
      if (!(key in obj) || obj[key] === undefined) errors.push({ path: `${path}.${key}`, message: 'Is required' });
    }
    for (const [key, v] of Object.entries(obj)) {
      if (props[key]) walk(props[key], v, `${path}.${key}`, errors, depth + 1);
      else if (schema.additionalProperties === false) errors.push({ path: `${path}.${key}`, message: 'Unknown property' });
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object')
        walk(schema.additionalProperties, v, `${path}.${key}`, errors, depth + 1);
    }
  }
}
