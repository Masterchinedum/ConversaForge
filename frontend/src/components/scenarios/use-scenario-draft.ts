'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { defaultScenarioConfig, setAtPath, validateScenarioForPublish, type ScenarioConfig, type ValidationIssue } from '@/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import type { EditorCtx } from './editor-context';
import type { ScenarioDetail } from './types';

export type SaveState = 'new' | 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

export const SAVE_LABELS: Record<SaveState, string> = {
  new: 'Not saved yet',
  saved: 'All changes saved',
  dirty: 'Unsaved changes…',
  saving: 'Saving…',
  error: 'Not saved',
  conflict: 'Conflict',
};

const AUTOSAVE_MS = 900;
const issueKey = (i: ValidationIssue) => `${i.severity}|${i.path}|${i.message}`;

/**
 * The scenario draft as edited in the browser: local config + locks, 900 ms autosave with the draft
 * revision (409 → conflict state, never silently overwritten), live validation (shared validator on the
 * local draft + the server's workspace-level issues) and the EditorContext value the field components use.
 *
 * With `initialId = null` (a new Studio draft) nothing is stored until the creator edits a field or sends
 * a message: the first save creates the scenario (`source: 'studio'`) and `onCreated` gets its id.
 */
export function useScenarioDraft(initialId: string | null, opts: { onCreated?: (id: string) => void } = {}) {
  const { wsPath, workspaceId } = useWorkspace();
  const { mutate: globalMutate } = useSWRConfig();
  const [scenarioId, setScenarioId] = useState<string | null>(initialId);
  const key = scenarioId ? wsPath(`/scenarios/${scenarioId}`) : null;
  const { data: detail, error, mutate } = useSWR<ScenarioDetail>(key);

  const [config, setConfig] = useState<ScenarioConfig | null>(() => (initialId ? null : defaultScenarioConfig()));
  const [locked, setLocked] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>(initialId ? 'saved' : 'new');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [savedConfig, setSavedConfig] = useState<ScenarioConfig | null>(null);

  const idRef = useRef<string | null>(initialId);
  const revisionRef = useRef(0);
  const seqRef = useRef(0);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createRef = useRef<Promise<string> | null>(null);
  const latest = useRef<{ config: ScenarioConfig | null; locked: string[] }>({ config: null, locked: [] });
  latest.current = { config, locked };
  const onCreated = useRef(opts.onCreated);
  onCreated.current = opts.onCreated;

  const applyDetail = useCallback(
    (d: ScenarioDetail) => {
      setConfig(d.draft.config);
      setSavedConfig(d.draft.config);
      setLocked(d.draft.lockedFields);
      setServerIssues(d.issues);
      revisionRef.current = d.draft.revision;
      seqRef.current += 1;
      setSaveState('saved');
      setSaveError(null);
      if (idRef.current) globalMutate(wsPath(`/scenarios/${idRef.current}`), d, { revalidate: false });
    },
    [globalMutate, wsPath],
  );

  useEffect(() => {
    if (detail && !config) applyDetail(detail);
  }, [detail, config, applyDetail]);

  /** Create the scenario from the local draft (once; concurrent callers share the request). */
  const ensureCreated = useCallback(async (): Promise<string> => {
    if (idRef.current) return idRef.current;
    if (!createRef.current) {
      createRef.current = (async () => {
        const seq = seqRef.current;
        const snap = latest.current;
        setSaveState('saving');
        try {
          const d = await api<ScenarioDetail>(wsPath('/scenarios'), {
            method: 'POST',
            body: { source: 'studio', config: (snap.config ?? {}) as unknown as Record<string, unknown>, lockedFields: snap.locked },
          });
          const id = d.scenario.id;
          idRef.current = id;
          revisionRef.current = d.draft.revision;
          await globalMutate(wsPath(`/scenarios/${id}`), d, { revalidate: false });
          setScenarioId(id);
          setServerIssues(d.issues);
          setSavedConfig(d.draft.config);
          setSaveError(null);
          setSaveState(seqRef.current === seq ? 'saved' : 'dirty');
          onCreated.current?.(id);
          return id;
        } catch (e) {
          createRef.current = null;
          setSaveState('error');
          setSaveError(errorMessage(e));
          throw e;
        }
      })();
    }
    return createRef.current;
  }, [globalMutate, wsPath]);

  /** Save the local draft now. Resolves true when the server has it. */
  const save = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const snapshot = latest.current;
    if (!snapshot.config) return false;
    if (!idRef.current) {
      try {
        await ensureCreated();
      } catch {
        return false;
      }
      // Edits made while creating are saved by the regular path below.
      if (latest.current.config === snapshot.config && latest.current.locked === snapshot.locked) return true;
    }
    if (savingRef.current) {
      timerRef.current = setTimeout(() => void save(), 300);
      return false;
    }
    savingRef.current = true;
    const seq = seqRef.current;
    setSaveState('saving');
    try {
      const d = await api<ScenarioDetail>(wsPath(`/scenarios/${idRef.current}/draft`), {
        method: 'PATCH',
        body: { revision: revisionRef.current, config: latest.current.config as unknown as Record<string, unknown>, lockedFields: latest.current.locked },
      });
      revisionRef.current = d.draft.revision;
      setServerIssues(d.issues);
      setSavedConfig(d.draft.config);
      globalMutate(wsPath(`/scenarios/${idRef.current}`), d, { revalidate: false });
      setSaveError(null);
      if (seqRef.current === seq) setSaveState('saved');
      else timerRef.current = setTimeout(() => void save(), AUTOSAVE_MS);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setSaveState('conflict');
      else {
        setSaveState('error');
        setSaveError(errorMessage(e));
      }
      return false;
    } finally {
      savingRef.current = false;
    }
  }, [ensureCreated, globalMutate, wsPath]);

  const schedule = useCallback(
    (delay = AUTOSAVE_MS) => {
      seqRef.current += 1;
      setSaveState((s) => (s === 'conflict' ? s : 'dirty'));
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        if (latest.current.config) void save();
      }, delay);
    },
    [save],
  );

  /** Save pending edits (if any) before an action that reads the server draft. */
  const flush = useCallback(async (): Promise<boolean> => {
    if (saveState === 'dirty' || saveState === 'error' || saveState === 'saving' || !idRef.current) return save();
    return saveState !== 'conflict';
  }, [save, saveState]);

  /** Replace the whole draft (YAML/JSON apply) and save immediately. */
  const replaceConfig = useCallback(
    async (c: ScenarioConfig) => {
      seqRef.current += 1;
      latest.current = { ...latest.current, config: c };
      setConfig(c);
      return save();
    },
    [save],
  );

  const resolveConflict = useCallback(
    async (keepMine: boolean) => {
      if (!idRef.current) return;
      const fresh = await api<ScenarioDetail>(wsPath(`/scenarios/${idRef.current}`));
      if (!keepMine) {
        applyDetail(fresh);
        return;
      }
      revisionRef.current = fresh.draft.revision;
      setSaveState('dirty');
      await save();
    },
    [applyDetail, save, wsPath],
  );

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (saveState === 'dirty' || saveState === 'saving' || saveState === 'error' || saveState === 'conflict') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [saveState]);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // Live issues = shared validator on the local draft + workspace-level issues from the last server check.
  const issues = useMemo(() => {
    if (!config) return [];
    const local = validateScenarioForPublish(config).issues;
    const serverShared = new Set(savedConfig ? validateScenarioForPublish(savedConfig).issues.map(issueKey) : []);
    const workspaceOnly = serverIssues.filter((i) => !serverShared.has(issueKey(i)));
    const seen = new Set(local.map(issueKey));
    return [...local, ...workspaceOnly.filter((i) => !seen.has(issueKey(i)))];
  }, [config, savedConfig, serverIssues]);

  const readOnly = saveState === 'conflict';
  const ctx: EditorCtx | null = useMemo(
    () =>
      config
        ? {
            config,
            workspaceId,
            readOnly,
            issues,
            lockedFields: locked,
            set: (path, value) => {
              setConfig((c) => (c ? setAtPath(c, path, value) : c));
              schedule();
            },
            toggleLock: (path) => {
              setLocked((l) => (l.includes(path) ? l.filter((x) => x !== path) : [...l, path]));
              schedule(50);
            },
          }
        : null,
    [config, workspaceId, readOnly, issues, locked, schedule],
  );

  return {
    scenarioId,
    key,
    detail,
    error,
    mutate,
    config,
    locked,
    issues,
    ctx,
    saveState,
    saveError,
    readOnly,
    revision: () => revisionRef.current,
    applyDetail,
    setServerIssues,
    markServerChecked: (c: ScenarioConfig | null) => setSavedConfig(c),
    save,
    flush,
    ensureCreated,
    replaceConfig,
    resolveConflict,
  };
}

export type ScenarioDraft = ReturnType<typeof useScenarioDraft>;
