import { createHash } from 'node:crypto';
import {
  EDITABLE_FIELD_PATHS,
  normalizeScenarioConfig,
  parseScenarioConfig,
  stableStringify,
  type ScenarioConfig,
} from '@cf/shared';

/** Top-level keys of ScenarioConfig; patch paths must start with one of these. */
export const CONFIG_ROOT_KEYS = [
  'schemaVersion',
  'basics',
  'persona',
  'instructions',
  'conversation',
  'model',
  'audio',
  'recording',
  'analysis',
  'rubric',
  'extraction',
  'variables',
  'memory',
  'coach',
  'tools',
  'knowledge',
  'channels',
  'access',
] as const;

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);
const SEGMENT_RE = /^(?:[a-zA-Z][a-zA-Z0-9_]{0,63}|\d{1,3})$/;

/**
 * A dotted config path is safe when every segment is a plain identifier or a small array index,
 * none of them can reach Object.prototype, and it starts at a known config root.
 */
export function isSafeConfigPath(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0 || path.length > 200) return false;
  const parts = path.split('.');
  if (parts.length > 8) return false;
  if (!(CONFIG_ROOT_KEYS as readonly string[]).includes(parts[0]!)) return false;
  return parts.every((p) => SEGMENT_RE.test(p) && !FORBIDDEN_SEGMENTS.has(p));
}

export function isEditableFieldPath(path: string): boolean {
  return (EDITABLE_FIELD_PATHS as readonly string[]).includes(path);
}

/** A path is locked when it equals a locked path, or one contains the other. */
export function isPathLocked(path: string, locked: readonly string[]): boolean {
  return locked.some((l) => path === l || path.startsWith(`${l}.`) || l.startsWith(`${path}.`));
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Hash of a normalized, schema-valid config (the value stored as ScenarioVersion.configHash). */
export function hashConfig(normalized: ScenarioConfig): string {
  return sha256(stableStringify(normalized));
}

/**
 * Hash the draft the same way publishing would, so "unpublished changes" compares like with like.
 * Returns null when the draft is not structurally valid (and therefore certainly differs).
 */
export function draftPublishHash(draftConfig: unknown): string | null {
  const parsed = parseScenarioConfig(draftConfig);
  if (!parsed.success) return null;
  return hashConfig(normalizeScenarioConfig(parsed.data));
}

export function deepEqualJson(a: unknown, b: unknown): boolean {
  return stableStringify(a ?? null) === stableStringify(b ?? null);
}

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'scenario'
  );
}

/** Zod issues → the API's validation-detail shape. */
export function zodIssuesToDetails(issues: Array<{ path: (string | number)[]; message: string }>) {
  return issues.map((i) => ({ path: i.path.join('.'), message: i.message, severity: 'error' as const }));
}
