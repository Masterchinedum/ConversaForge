'use client';
import { createContext, useContext } from 'react';
import { EDITABLE_FIELD_PATHS, getAtPath, type ScenarioConfig, type ValidationIssue } from '@/shared';

export interface EditorCtx {
  config: ScenarioConfig;
  set: (path: string, value: unknown) => void;
  lockedFields: string[];
  toggleLock: (path: string) => void;
  readOnly: boolean;
  issues: ValidationIssue[];
  workspaceId: string;
  /** Scenario Studio: whether the assistant has a pending suggestion for, or just updated, a lockable field. */
  aiMark?: (path: string) => 'pending' | 'updated' | 'working' | 'ai' | null;
}

export const EditorContext = createContext<EditorCtx | null>(null);

export function useEditor(): EditorCtx {
  const ctx = useContext(EditorContext);
  if (!ctx) throw new Error('useEditor outside EditorContext');
  return ctx;
}

export function useField<T = unknown>(path: string): [T, (v: T) => void] {
  const { config, set } = useEditor();
  return [getAtPath(config, path) as T, (v: T) => set(path, v)];
}

/** DOM id for a config path (validation links scroll/focus to it). */
export function fieldDomId(path: string) {
  return `field-${path.replace(/[^a-zA-Z0-9]+/g, '-')}`;
}

/** The lockable (EDITABLE_FIELD_PATHS) ancestor of a path, if any. */
export function lockablePathFor(path: string): string | null {
  let best: string | null = null;
  for (const p of EDITABLE_FIELD_PATHS) if ((path === p || path.startsWith(`${p}.`)) && (!best || p.length > best.length)) best = p;
  return best;
}

/** Scroll to and focus the closest rendered field for an issue path (e.g. rubric.criteria.0.weight). */
export function focusField(path: string): boolean {
  const parts = path.split('.');
  for (let i = parts.length; i > 0; i--) {
    const el = document.getElementById(fieldDomId(parts.slice(0, i).join('.')));
    if (el) {
      // Fields inside collapsed <details> (e.g. "More options") are revealed first.
      for (let d = el.closest('details'); d; d = d.parentElement?.closest('details') ?? null) d.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Prefer the field's control over the lock button that precedes it.
      const focusable = (el.matches('input,textarea,select,button') ? el : el.querySelector('input:not([type=hidden]),textarea,select') ?? el.querySelector('button')) as HTMLElement | null;
      focusable?.focus({ preventScroll: true });
      el.classList.add('ring-2', 'ring-amber-400');
      setTimeout(() => el.classList.remove('ring-2', 'ring-amber-400'), 1600);
      return true;
    }
  }
  return false;
}

export function issuesFor(issues: ValidationIssue[], path: string) {
  return issues.filter((i) => i.path === path || i.path.startsWith(`${path}.`));
}
