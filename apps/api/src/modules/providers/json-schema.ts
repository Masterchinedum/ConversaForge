/**
 * Compact JSON Schema subset used for custom-function parameters (exposed to the model as tool
 * input schemas, and enforced server-side before any outbound call).
 *
 * Supported keywords: type (incl. arrays of types), properties, required, additionalProperties
 * (boolean or schema), enum, const, minLength, maxLength, pattern, format (annotation only),
 * minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf, items, minItems, maxItems,
 * uniqueItems, anyOf, oneOf, allOf, plus annotations (title, description, default, examples).
 * `$ref`/`$defs`/`if`/`then`/`not`/`patternProperties`/dependent* are rejected at save time so a
 * schema never silently validates less than it appears to.
 */

export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_SCHEMA_DEPTH = 8;
export const MAX_ARGS_BYTES = 16 * 1024;

const TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null'] as const;
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', 'format', '$schema', '$comment', 'deprecated', 'readOnly', 'writeOnly']);
const KEYWORDS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'enum',
  'const',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'items',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'anyOf',
  'oneOf',
  'allOf',
]);

export interface SchemaIssue {
  path: string;
  message: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNonNegInt = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

/** Validate that `schema` is a supported JSON Schema whose root is `type: "object"`. */
export function validateParametersSchema(schema: unknown): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (!isObj(schema)) return [{ path: '', message: 'Parameters schema must be a JSON object' }];
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(schema), 'utf8');
  } catch {
    return [{ path: '', message: 'Parameters schema must be serializable JSON' }];
  }
  if (size > MAX_SCHEMA_BYTES) issues.push({ path: '', message: `Schema is too large (max ${MAX_SCHEMA_BYTES / 1024} KB)` });
  if (schema.type !== 'object') issues.push({ path: 'type', message: 'The root schema must have "type": "object"' });
  walk(schema, '', 0, issues);
  return issues;
}

function walk(s: unknown, path: string, depth: number, issues: SchemaIssue[]) {
  const at = (k: string) => (path ? `${path}.${k}` : k);
  if (typeof s === 'boolean') return;
  if (!isObj(s)) {
    issues.push({ path, message: 'Schema must be an object' });
    return;
  }
  if (depth > MAX_SCHEMA_DEPTH) {
    issues.push({ path, message: `Schema is nested too deeply (max ${MAX_SCHEMA_DEPTH})` });
    return;
  }
  for (const [k, v] of Object.entries(s)) {
    if (ANNOTATIONS.has(k)) {
      if ((k === 'title' || k === 'description') && typeof v !== 'string') issues.push({ path: at(k), message: `${k} must be a string` });
      continue;
    }
    if (!KEYWORDS.has(k)) {
      issues.push({ path: at(k), message: `Unsupported schema keyword "${k}"` });
      continue;
    }
    switch (k) {
      case 'type': {
        const list = Array.isArray(v) ? v : [v];
        if (!list.length || !list.every((t) => (TYPES as readonly unknown[]).includes(t))) {
          issues.push({ path: at(k), message: `type must be one of ${TYPES.join(', ')}` });
        }
        break;
      }
      case 'properties':
        if (!isObj(v)) issues.push({ path: at(k), message: 'properties must be an object' });
        else {
          if (Object.keys(v).length > 100) issues.push({ path: at(k), message: 'At most 100 properties are supported' });
          for (const [pk, pv] of Object.entries(v)) {
            if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(pk)) issues.push({ path: at(`properties.${pk}`), message: 'Property names must be 1–64 chars: letters, digits, _ . -' });
            walk(pv, at(`properties.${pk}`), depth + 1, issues);
          }
        }
        break;
      case 'required':
        if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) issues.push({ path: at(k), message: 'required must be an array of strings' });
        else if (isObj(s.properties)) {
          for (const r of v) if (!(r in (s.properties as object))) issues.push({ path: at(k), message: `required property "${r}" is not defined in properties` });
        }
        break;
      case 'additionalProperties':
      case 'items':
        if (typeof v !== 'boolean' && !isObj(v)) issues.push({ path: at(k), message: `${k} must be a boolean or a schema` });
        else walk(v, at(k), depth + 1, issues);
        break;
      case 'enum':
        if (!Array.isArray(v) || !v.length || v.length > 200) issues.push({ path: at(k), message: 'enum must be a non-empty array (max 200 values)' });
        break;
      case 'const':
        break;
      case 'minLength':
      case 'maxLength':
      case 'minItems':
      case 'maxItems':
      case 'minProperties':
      case 'maxProperties':
        if (!isNonNegInt(v)) issues.push({ path: at(k), message: `${k} must be a non-negative integer` });
        break;
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum':
        if (typeof v !== 'number' || !Number.isFinite(v)) issues.push({ path: at(k), message: `${k} must be a number` });
        break;
      case 'multipleOf':
        if (typeof v !== 'number' || !(v > 0)) issues.push({ path: at(k), message: 'multipleOf must be a positive number' });
        break;
      case 'uniqueItems':
        if (typeof v !== 'boolean') issues.push({ path: at(k), message: 'uniqueItems must be a boolean' });
        break;
      case 'pattern':
        if (typeof v !== 'string' || v.length > 200) issues.push({ path: at(k), message: 'pattern must be a string (max 200 chars)' });
        else if (/(\([^)]*[+*][^)]*\))[+*{]/.test(v)) issues.push({ path: at(k), message: 'pattern contains nested quantifiers (catastrophic backtracking risk)' });
        else {
          try {
            new RegExp(v, 'u');
          } catch {
            issues.push({ path: at(k), message: 'pattern is not a valid regular expression' });
          }
        }
        break;
      case 'anyOf':
      case 'oneOf':
      case 'allOf':
        if (!Array.isArray(v) || !v.length || v.length > 20) issues.push({ path: at(k), message: `${k} must be a non-empty array (max 20)` });
        else v.forEach((sub, i) => walk(sub, at(`${k}.${i}`), depth + 1, issues));
        break;
    }
  }
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Validate a value against a (pre-validated) schema. Returns issues (empty = valid). */
export function validateValue(schema: unknown, value: unknown, path = '', out: SchemaIssue[] = []): SchemaIssue[] {
  if (schema === true || schema === undefined) return out;
  if (schema === false) {
    out.push({ path, message: 'No value is allowed here' });
    return out;
  }
  if (!isObj(schema)) return out;
  const at = (k: string | number) => (path ? `${path}.${k}` : String(k));
  const t = typeOf(value);

  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    const ok = types.some((ty) => ty === t || (ty === 'number' && t === 'integer'));
    if (!ok) {
      out.push({ path, message: `must be ${types.join(' or ')}` });
      return out;
    }
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => deepEqual(e, value))) out.push({ path, message: `must be one of ${JSON.stringify(schema.enum).slice(0, 200)}` });
  if ('const' in schema && !deepEqual(schema.const, value)) out.push({ path, message: `must equal ${JSON.stringify(schema.const).slice(0, 100)}` });

  if (t === 'string') {
    const s = value as string;
    const len = [...s].length;
    if (typeof schema.minLength === 'number' && len < schema.minLength) out.push({ path, message: `must be at least ${schema.minLength} characters` });
    if (typeof schema.maxLength === 'number' && len > schema.maxLength) out.push({ path, message: `must be at most ${schema.maxLength} characters` });
    if (typeof schema.pattern === 'string' && s.length <= 10_000) {
      try {
        if (!new RegExp(schema.pattern, 'u').test(s)) out.push({ path, message: `must match pattern ${schema.pattern}` });
      } catch {
        /* invalid pattern rejected at save time */
      }
    }
  }
  if (t === 'number' || t === 'integer') {
    const n = value as number;
    if (!Number.isFinite(n)) out.push({ path, message: 'must be a finite number' });
    if (typeof schema.minimum === 'number' && n < schema.minimum) out.push({ path, message: `must be ≥ ${schema.minimum}` });
    if (typeof schema.maximum === 'number' && n > schema.maximum) out.push({ path, message: `must be ≤ ${schema.maximum}` });
    if (typeof schema.exclusiveMinimum === 'number' && n <= schema.exclusiveMinimum) out.push({ path, message: `must be > ${schema.exclusiveMinimum}` });
    if (typeof schema.exclusiveMaximum === 'number' && n >= schema.exclusiveMaximum) out.push({ path, message: `must be < ${schema.exclusiveMaximum}` });
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const q = n / schema.multipleOf;
      if (Math.abs(q - Math.round(q)) > 1e-9) out.push({ path, message: `must be a multiple of ${schema.multipleOf}` });
    }
  }
  if (t === 'array') {
    const arr = value as unknown[];
    if (typeof schema.minItems === 'number' && arr.length < schema.minItems) out.push({ path, message: `must have at least ${schema.minItems} items` });
    if (typeof schema.maxItems === 'number' && arr.length > schema.maxItems) out.push({ path, message: `must have at most ${schema.maxItems} items` });
    if (schema.uniqueItems === true && new Set(arr.map((x) => JSON.stringify(x))).size !== arr.length) out.push({ path, message: 'items must be unique' });
    if (schema.items !== undefined) arr.forEach((item, i) => validateValue(schema.items, item, at(i), out));
  }
  if (t === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const props = isObj(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const r of schema.required as string[]) if (!(r in obj) || obj[r] === undefined) out.push({ path: at(r), message: 'is required' });
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) out.push({ path, message: `must have at least ${schema.minProperties} properties` });
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) out.push({ path, message: `must have at most ${schema.maxProperties} properties` });
    for (const k of keys) {
      if (k in props) validateValue(props[k], obj[k], at(k), out);
      else if (schema.additionalProperties === false) out.push({ path: at(k), message: 'is not an allowed property' });
      else if (isObj(schema.additionalProperties)) validateValue(schema.additionalProperties, obj[k], at(k), out);
    }
  }
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) validateValue(sub, value, path, out);
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((sub) => validateValue(sub, value, path).length === 0)) {
    out.push({ path, message: 'does not match any allowed shape (anyOf)' });
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.filter((sub) => validateValue(sub, value, path).length === 0).length !== 1) {
    out.push({ path, message: 'must match exactly one allowed shape (oneOf)' });
  }
  return out;
}

/** Validate tool-call arguments (must be a plain JSON object within the size cap). */
export function validateArgs(schema: unknown, args: unknown): SchemaIssue[] {
  if (!isObj(args)) return [{ path: '', message: 'Arguments must be a JSON object' }];
  let size: number;
  try {
    size = Buffer.byteLength(JSON.stringify(args), 'utf8');
  } catch {
    return [{ path: '', message: 'Arguments must be serializable JSON' }];
  }
  if (size > MAX_ARGS_BYTES) return [{ path: '', message: `Arguments are too large (max ${MAX_ARGS_BYTES / 1024} KB)` }];
  return validateValue(schema, args).slice(0, 20);
}
