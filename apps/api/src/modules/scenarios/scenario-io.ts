import YAML from 'yaml';
import { parseScenarioConfig, type ScenarioConfig } from '@cf/shared';
import { Errors } from '../../common/http/errors';
import { zodIssuesToDetails } from './scenario-utils';

/**
 * YAML / JSON import & export for scenario configs.
 *
 * Imports are treated strictly as DATA:
 *  - hard size cap (200 KB) before parsing,
 *  - YAML "core" schema only, no custom tags (so `!!js/function`, `!!python/object` … are rejected),
 *    no merge keys, alias expansion capped (billion-laughs protection), duplicate keys rejected,
 *  - prototype-sensitive keys (__proto__, constructor, prototype) are stripped,
 *  - the result is validated with the ScenarioConfig zod schema; nothing is ever evaluated.
 */

export const IMPORT_MAX_BYTES = 200 * 1024;
const MAX_DEPTH = 32;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export type ImportFormat = 'yaml' | 'json' | 'auto';

export class ScenarioImportError extends Error {
  constructor(
    message: string,
    public readonly details: Array<{ path: string; message: string; severity: 'error' }> = [],
  ) {
    super(message);
  }
}

/** Parse YAML/JSON text into plain data (no validation against the scenario schema). */
export function parseConfigText(text: string, format: ImportFormat = 'auto'): unknown {
  if (typeof text !== 'string') throw new ScenarioImportError('Import text must be a string');
  if (Buffer.byteLength(text, 'utf8') > IMPORT_MAX_BYTES) {
    throw new ScenarioImportError(`Import is too large (max ${IMPORT_MAX_BYTES / 1024} KB)`);
  }
  if (!text.trim()) throw new ScenarioImportError('Import is empty');

  const trimmed = text.trimStart();
  const useJson = format === 'json' || (format === 'auto' && (trimmed.startsWith('{') || trimmed.startsWith('[')));
  let data: unknown;
  try {
    data = useJson ? JSON.parse(text) : parseYamlStrict(text);
  } catch (e) {
    if (e instanceof ScenarioImportError) throw e;
    const msg = e instanceof RangeError ? 'Document is nested too deeply' : (e as Error)?.message ?? 'Parse error';
    throw new ScenarioImportError(`Could not parse ${useJson ? 'JSON' : 'YAML'}: ${truncate(msg, 400)}`);
  }
  return scrub(data, 0);
}

function parseYamlStrict(text: string): unknown {
  const doc = YAML.parseDocument(text, {
    schema: 'core',
    customTags: [],
    merge: false,
    uniqueKeys: true,
    prettyErrors: true,
    strict: true,
    version: '1.2',
  });
  const problems = [...doc.errors, ...doc.warnings];
  if (problems.length) {
    const first = problems[0]!;
    const tagIssue = problems.find((p) => p.code === 'TAG_RESOLVE_FAILED' || /tag/i.test(p.message));
    throw new ScenarioImportError(
      tagIssue
        ? `Unsupported YAML tag: only plain data (strings, numbers, booleans, lists, maps) is allowed`
        : `Could not parse YAML: ${truncate(first.message, 400)}`,
    );
  }
  // Alias expansion cap: throws ReferenceError "Excessive alias count" on YAML bombs.
  try {
    return doc.toJS({ maxAliasCount: 50 });
  } catch (e) {
    throw new ScenarioImportError(`Could not parse YAML: ${truncate((e as Error)?.message ?? 'invalid aliases', 200)}`);
  }
}

/** Deep-copy plain data, dropping prototype-sensitive keys and rejecting absurd nesting. */
function scrub(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) throw new ScenarioImportError('Document is nested too deeply');
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
      throw new ScenarioImportError('Unsupported value type');
    }
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (value instanceof Map || value instanceof Set) throw new ScenarioImportError('Unsupported value type');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DANGEROUS_KEYS.has(k)) continue;
    Object.defineProperty(out, k, { value: scrub(v, depth + 1), enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/** Remove prototype-sensitive keys from any JSON-ish input (request bodies, model output). */
export function scrubData<T = unknown>(value: T): T {
  return scrub(value, 0) as T;
}

/**
 * Import text as a ScenarioConfig. Accepts either a bare config or an export envelope
 * `{ kind: "conversaforge.scenario", config: {...} }`.
 */
export function importScenarioConfig(text: string, format: ImportFormat = 'auto'): ScenarioConfig {
  const data = parseConfigText(text, format);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ScenarioImportError('Import must be a mapping/object at the top level');
  }
  const obj = data as Record<string, unknown>;
  const candidate =
    obj.kind === 'conversaforge.scenario' && obj.config && typeof obj.config === 'object' ? obj.config : obj;
  const parsed = parseScenarioConfig(candidate);
  if (!parsed.success) {
    throw new ScenarioImportError('Imported scenario does not match the scenario schema', zodIssuesToDetails(parsed.error.issues));
  }
  return parsed.data;
}

export function toHttpError(e: unknown): never {
  if (e instanceof ScenarioImportError) throw Errors.validation(e.message, e.details.length ? e.details : undefined);
  throw e;
}

export function exportScenarioConfig(config: unknown, format: 'yaml' | 'json', meta: { name: string; version?: number | null; source: string }): string {
  if (format === 'json') return `${JSON.stringify(config, null, 2)}\n`;
  const header = [
    `# ConversaForge scenario: ${meta.name.replace(/[\r\n]+/g, ' ')}`,
    `# Source: ${meta.source}${meta.version ? ` (version ${meta.version})` : ''}`,
    `# Exported: ${new Date().toISOString()}`,
    '# This file is plain data. Import it via "New scenario → Import YAML".',
  ].join('\n');
  return `${header}\n${YAML.stringify(config, { lineWidth: 0, aliasDuplicateObjects: false })}`;
}

function truncate(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}
