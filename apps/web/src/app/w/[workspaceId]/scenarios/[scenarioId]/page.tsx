'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import { setAtPath, validateScenarioForPublish, type ScenarioConfig, type ValidationIssue } from '@cf/shared';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Loading, Tabs, clsx, useToast } from '@/components/ui';
import { EditorContext, focusField, type EditorCtx } from '@/components/scenarios/editor-context';
import { AssistantPanel, PreviewTab, PublishModal, ValidationPanel, VersionsTab, YamlEditor } from '@/components/scenarios/panels';
import {
  AccessSection,
  AnalysisSection,
  AudioSection,
  BasicsSection,
  ChannelsSection,
  ConversationSection,
  EndingSection,
  ExtractionSection,
  InstructionsSection,
  KnowledgeSection,
  MemoryCoachSection,
  ModelSection,
  PersonaSection,
  RecordingSection,
  RubricSection,
  TimedInstructionsSection,
  ToolsSection,
  TurnTakingSection,
  VariablesSection,
  Group,
  AgendaEditor,
  FirstTurnEditor,
} from '@/components/scenarios/sections';
import { StatusBadge } from '@/components/scenarios/status-badge';
import { startSelfRun } from '@/components/scenarios/new-scenario';
import { NumberField, TextAreaField, TextField, ToggleField } from '@/components/scenarios/fields';
import type { ScenarioDetail } from '@/components/scenarios/types';

type Mode = 'guided' | 'advanced' | 'yaml' | 'versions' | 'preview';
type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

const AUTOSAVE_MS = 900;
const issueKey = (i: ValidationIssue) => `${i.severity}|${i.path}|${i.message}`;

export default function ScenarioEditorPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const { wsPath, href, can, workspaceId } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const key = wsPath(`/scenarios/${scenarioId}`);
  const { data: detail, error, mutate } = useSWR<ScenarioDetail>(can('scenarios.edit') ? key : null);

  const [config, setConfig] = useState<ScenarioConfig | null>(null);
  const [locked, setLocked] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [serverIssues, setServerIssues] = useState<ValidationIssue[]>([]);
  const [savedConfig, setSavedConfig] = useState<ScenarioConfig | null>(null);
  const [mode, setMode] = useState<Mode>('advanced');
  const [showPublish, setShowPublish] = useState(false);
  const [showAssistant, setShowAssistant] = useState(true);
  const [starting, setStarting] = useState(false);

  const revisionRef = useRef(0);
  const seqRef = useRef(0);
  const savingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef<{ config: ScenarioConfig | null; locked: string[] }>({ config: null, locked: [] });
  latest.current = { config, locked };

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
      mutate(d, { revalidate: false });
    },
    [mutate],
  );

  // First load: pick guided mode for brand-new, mostly empty drafts.
  useEffect(() => {
    if (detail && !config) {
      applyDetail(detail);
      if (!detail.latestVersion && !detail.draft.config.persona.role && !detail.draft.config.instructions.goals.length) setMode('guided');
    }
  }, [detail, config, applyDetail]);

  const save = useCallback(async () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const snapshot = latest.current;
    if (!snapshot.config) return;
    if (savingRef.current) {
      timerRef.current = setTimeout(() => void save(), 300);
      return;
    }
    savingRef.current = true;
    const seq = seqRef.current;
    setSaveState('saving');
    try {
      const d = await api<ScenarioDetail>(`${key}/draft`, {
        method: 'PATCH',
        body: { revision: revisionRef.current, config: snapshot.config as unknown as Record<string, unknown>, lockedFields: snapshot.locked },
      });
      revisionRef.current = d.draft.revision;
      setServerIssues(d.issues);
      setSavedConfig(d.draft.config);
      mutate(d, { revalidate: false });
      setSaveError(null);
      if (seqRef.current === seq) setSaveState('saved');
      else timerRef.current = setTimeout(() => void save(), AUTOSAVE_MS);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setSaveState('conflict');
      } else {
        setSaveState('error');
        setSaveError(errorMessage(e));
      }
    } finally {
      savingRef.current = false;
    }
  }, [key, mutate]);

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

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

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

  if (!can('scenarios.edit')) return <ErrorState error={new Error('Only creators can edit scenarios.')} />;
  if (error instanceof ApiError && error.status === 404)
    return (
      <EmptyState
        title="Scenario not found"
        description="It may have been deleted, or it belongs to another workspace."
        action={
          <Link className="text-brand-700 hover:underline" href={href('/scenarios')}>
            Back to scenarios
          </Link>
        }
      />
    );
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!detail || !ctx || !config) return <Loading />;

  const s = detail.scenario;
  const published = !!s.latestVersionId && s.status === 'PUBLISHED';

  const goto = (path: string) => {
    if (mode !== 'advanced') setMode('advanced');
    setTimeout(() => focusField(path), mode === 'advanced' ? 0 : 120);
  };

  const flush = async () => {
    if (saveState === 'dirty' || saveState === 'error') await save();
  };

  const publish = async (changeNote: string) => {
    await flush();
    try {
      const r = await api<{ version: { version: number }; scenario: ScenarioDetail }>(`${key}/publish`, {
        method: 'POST',
        body: { changeNote: changeNote || undefined, revision: revisionRef.current },
      });
      applyDetail(r.scenario);
      setShowPublish(false);
      toast.success(`Published version ${r.version.version}`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const validateNow = async () => {
    await flush();
    try {
      const r = await api<{ ok: boolean; issues: ValidationIssue[] }>(`${key}/validate`, { method: 'POST', body: {} });
      setServerIssues(r.issues);
      setSavedConfig(latest.current.config);
      const errs = r.issues.filter((i) => i.severity === 'error').length;
      if (r.ok) toast.success(`Valid — ${r.issues.length} warning(s)`);
      else toast.error(`${errs} error(s) must be fixed before publishing`);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const duplicate = async () => {
    await flush();
    try {
      const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body: { source: 'duplicate', scenarioId: s.id } });
      toast.success('Duplicated');
      router.push(href(`/scenarios/${d.scenario.id}`));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const tryIt = async () => {
    setStarting(true);
    try {
      router.push(await startSelfRun(wsPath, s.id));
    } catch (e) {
      toast.error(errorMessage(e));
      setStarting(false);
    }
  };

  const resolveConflict = async (keepMine: boolean) => {
    const fresh = await api<ScenarioDetail>(key);
    if (!keepMine) {
      applyDetail(fresh);
      toast.info('Loaded the latest draft');
      return;
    }
    revisionRef.current = fresh.draft.revision;
    setSaveState('dirty');
    await save();
  };

  const saveLabel: Record<SaveState, string> = {
    saved: 'All changes saved',
    dirty: 'Unsaved changes…',
    saving: 'Saving…',
    error: 'Not saved',
    conflict: 'Conflict',
  };

  return (
    <EditorContext.Provider value={ctx}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <Link href={href('/scenarios')} className="text-xs text-slate-500 hover:text-slate-800">
              ← Scenarios
            </Link>
            <h1 className="truncate text-xl font-semibold text-slate-900" data-testid="scenario-title">
              {config.basics.name || 'Untitled scenario'}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
              <StatusBadge row={{ ...s, draftHasUnpublishedChanges: detail.draftHasUnpublishedChanges }} />
              {detail.latestVersion && (
                <span>
                  v{detail.latestVersion.version} published {formatDate(detail.latestVersion.publishedAt)}
                </span>
              )}
              <span aria-live="polite" data-testid="save-state" className={clsx(saveState === 'error' || saveState === 'conflict' ? 'text-red-700' : saveState === 'saved' ? 'text-emerald-700' : 'text-slate-500')}>
                {saveLabel[saveState]}
              </span>
              <span className="text-slate-400">rev {revisionRef.current}</span>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="secondary" size="sm" onClick={validateNow}>
              Validate
            </Button>
            <Button variant="secondary" size="sm" onClick={() => setMode('preview')}>
              Preview
            </Button>
            <Button variant="secondary" size="sm" onClick={duplicate}>
              Duplicate
            </Button>
            <Button variant="secondary" size="sm" onClick={() => download(`${key}/export`, `${s.slug}.yaml`, { format: 'yaml', source: 'draft' }).catch((e) => toast.error(errorMessage(e)))}>
              Export YAML
            </Button>
            <Button variant="secondary" size="sm" onClick={() => download(`${key}/export`, `${s.slug}.json`, { format: 'json', source: 'draft' }).catch((e) => toast.error(errorMessage(e)))}>
              JSON
            </Button>
            <Button size="sm" onClick={() => setShowPublish(true)} disabled={!can('scenarios.publish') || s.status === 'ARCHIVED'} data-testid="publish">
              Publish
            </Button>
          </div>
        </div>
        <nav className="flex flex-wrap gap-2 text-sm" aria-label="Scenario">
          <ButtonLink variant="ghost" size="sm" href={href(`/scenarios/${s.id}/access`)}>
            Share & access
          </ButtonLink>
          <ButtonLink variant="ghost" size="sm" href={`${href('/sessions')}?scenarioId=${s.id}`}>
            Sessions ({detail.sessionCount})
          </ButtonLink>
          <Button variant="ghost" size="sm" onClick={tryIt} loading={starting} disabled={!published} title={published ? 'Start a practice session with the latest published version' : 'Publish first'}>
            ▶ Try it
          </Button>
        </nav>

        {saveState === 'conflict' && (
          <Alert tone="error" title="This draft was changed somewhere else">
            <p>Someone (or another tab) saved a newer revision. Choose which version to keep.</p>
            <div className="mt-2 flex gap-2">
              <Button size="sm" variant="secondary" onClick={() => resolveConflict(false)}>
                Load latest (discard mine)
              </Button>
              <Button size="sm" variant="danger" onClick={() => resolveConflict(true)}>
                Overwrite with mine
              </Button>
            </div>
          </Alert>
        )}
        {saveState === 'error' && saveError && (
          <Alert tone="error" title="Could not save">
            {saveError}
          </Alert>
        )}

        <Tabs
          tabs={[
            { id: 'guided' as Mode, label: 'Guided' },
            { id: 'advanced' as Mode, label: 'Advanced' },
            { id: 'yaml' as Mode, label: 'YAML / JSON' },
            { id: 'versions' as Mode, label: `Versions${s.latestVersionNumber ? ` (${s.latestVersionNumber})` : ''}` },
            { id: 'preview' as Mode, label: 'Preview' },
          ]}
          value={mode}
          onChange={setMode}
        />

        <div className={clsx('grid gap-4', (mode === 'guided' || mode === 'advanced' || mode === 'yaml') && 'lg:grid-cols-[minmax(0,1fr)_22rem]')}>
          <div className="min-w-0 space-y-4">
            {mode === 'guided' && <GuidedWizard onPublish={() => setShowPublish(true)} onGoto={goto} issues={issues} />}
            {mode === 'advanced' && <AdvancedEditor />}
            {mode === 'yaml' && (
              <YamlEditor
                config={config}
                readOnly={readOnly}
                onApply={async (c) => {
                  try {
                    const d = await api<ScenarioDetail>(`${key}/draft`, { method: 'PATCH', body: { revision: revisionRef.current, config: c as unknown as Record<string, unknown> } });
                    applyDetail(d);
                    toast.success('Applied');
                  } catch (e) {
                    if (e instanceof ApiError && e.status === 409) setSaveState('conflict');
                    toast.error(errorMessage(e));
                    throw e;
                  }
                }}
              />
            )}
            {mode === 'versions' && <VersionsTab wsPath={wsPath} scenarioId={s.id} canPublish={can('scenarios.publish')} onRolledBack={applyDetail} />}
            {mode === 'preview' && <PreviewTab wsPath={wsPath} scenarioId={s.id} revision={revisionRef.current} hasVersion={!!s.latestVersionId} />}
          </div>
          {(mode === 'guided' || mode === 'advanced' || mode === 'yaml') && (
            <aside className="space-y-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:overflow-y-auto">
              <Card title="Validation">
                <ValidationPanel issues={issues} onGoto={goto} />
              </Card>
              <Card
                title="Drafting assistant"
                actions={
                  <Button variant="ghost" size="sm" onClick={() => setShowAssistant((v) => !v)} aria-expanded={showAssistant}>
                    {showAssistant ? 'Hide' : 'Show'}
                  </Button>
                }
              >
                {showAssistant && (
                  <AssistantPanel
                    wsPath={wsPath}
                    scenarioId={s.id}
                    readOnly={readOnly}
                    onApplied={async (d) => {
                      if (saveState === 'dirty') await save();
                      applyDetail(d);
                    }}
                  />
                )}
              </Card>
            </aside>
          )}
        </div>
      </div>
      <PublishModal open={showPublish} onClose={() => setShowPublish(false)} issues={issues} onPublish={publish} latestVersion={s.latestVersionNumber} />
    </EditorContext.Provider>
  );
}

function AdvancedEditor() {
  const sections: Array<[string, string]> = [
    ['sec-basics', 'Basics'],
    ['sec-persona', 'Persona'],
    ['sec-instructions', 'Instructions'],
    ['sec-conversation', 'Conversation'],
    ['sec-rubric', 'Rubric'],
    ['sec-more', 'Model & more'],
  ];
  return (
    <div className="space-y-4">
      <nav aria-label="Sections" className="flex flex-wrap gap-2 text-xs">
        {sections.map(([id, label]) => (
          <a key={id} href={`#${id}`} className="rounded-full bg-slate-100 px-2 py-1 text-slate-700 hover:bg-slate-200">
            {label}
          </a>
        ))}
      </nav>
      <BasicsSection />
      <PersonaSection />
      <InstructionsSection />
      <ConversationSection />
      <TurnTakingSection />
      <TimedInstructionsSection />
      <EndingSection />
      <div id="sec-rubric" />
      <RubricSection />
      <ExtractionSection />
      <VariablesSection />
      <div id="sec-more" />
      <ModelSection />
      <AudioSection />
      <RecordingSection />
      <AnalysisSection />
      <MemoryCoachSection />
      <ToolsSection />
      <KnowledgeSection />
      <ChannelsSection />
      <AccessSection />
    </div>
  );
}

const STEPS = ['Basics', 'AI persona & goals', 'Conversation', 'Ending & timing', 'Feedback', 'Data to extract', 'Review & publish'] as const;
const STEP_PATHS: string[][] = [
  ['basics'],
  ['persona', 'instructions'],
  ['conversation.agenda', 'conversation.firstTurn', 'conversation.strategy'],
  ['conversation.ending', 'basics.targetDurationMinutes', 'conversation.timedInstructions'],
  ['rubric'],
  ['extraction', 'variables'],
  [],
];

function GuidedWizard({ onPublish, onGoto, issues }: { onPublish: () => void; onGoto: (p: string) => void; issues: ValidationIssue[] }) {
  const [step, setStep] = useState(0);
  const stepErrors = (i: number) => issues.filter((x) => x.severity === 'error' && STEP_PATHS[i]!.some((p) => x.path === p || x.path.startsWith(`${p}.`))).length;
  return (
    <div className="space-y-4">
      <ol className="flex flex-wrap gap-1" aria-label="Steps">
        {STEPS.map((label, i) => (
          <li key={label}>
            <button
              type="button"
              onClick={() => setStep(i)}
              aria-current={step === i ? 'step' : undefined}
              className={clsx('rounded-full px-3 py-1 text-xs', step === i ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200')}
            >
              {i + 1}. {label}
              {stepErrors(i) > 0 && <span className="ml-1 rounded-full bg-red-500 px-1.5 text-white">{stepErrors(i)}</span>}
            </button>
          </li>
        ))}
      </ol>

      {step === 0 && <BasicsSection />}
      {step === 1 && (
        <>
          <PersonaSection advanced={false} />
          <InstructionsSection advanced={false} />
        </>
      )}
      {step === 2 && (
        <Group title="Conversation">
          <FirstTurnEditor />
          <AgendaEditor />
        </Group>
      )}
      {step === 3 && (
        <Group title="Ending & timing">
          <div className="grid gap-4 sm:grid-cols-2">
            <NumberField path="basics.targetDurationMinutes" label="Target duration (minutes)" min={1} max={240} />
            <NumberField path="conversation.ending.maxDurationMinutes" label="Maximum duration (minutes)" min={1} max={240} />
          </div>
          <TextAreaField path="conversation.ending.closingMessage" label="Closing message" rows={2} />
          <ToggleField path="conversation.ending.endWhenAgendaComplete" label="Close when all required agenda topics are covered" />
        </Group>
      )}
      {step === 4 && <RubricSection />}
      {step === 5 && (
        <>
          <ExtractionSection />
          <VariablesSection />
        </>
      )}
      {step === 6 && (
        <Card title="Review & publish">
          <div className="space-y-3">
            <TextField path="basics.name" label="Name" />
            <ValidationPanel issues={issues} onGoto={onGoto} />
            <Button onClick={onPublish}>Publish…</Button>
          </div>
        </Card>
      )}
      <div className="flex justify-between">
        <Button variant="secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </Button>
        {step < STEPS.length - 1 && <Button onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1]}</Button>}
      </div>
      <p className="text-xs text-slate-500">
        <Badge tone="gray">Tip</Badge> Everything else (voice, turn-taking, tools, knowledge, channels…) lives in the Advanced tab.
      </p>
    </div>
  );
}
