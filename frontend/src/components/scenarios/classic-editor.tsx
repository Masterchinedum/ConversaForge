'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { ValidationIssue } from '@/shared';
import { ApiError, api, download, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Loading, Tabs, clsx, useToast } from '@/components/ui';
import { EditorContext, focusField } from './editor-context';
import { SAVE_LABELS, useScenarioDraft } from './use-scenario-draft';
import { AssistantPanel, PreviewTab, PublishModal, ValidationPanel, VersionsTab, YamlEditor } from './panels';
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
} from './sections';
import { StatusBadge } from './status-badge';
import { MeetingPracticeModal } from './meeting-practice';
import { startSelfRun } from './new-scenario';
import { NumberField, TextAreaField, TextField, ToggleField } from './fields';
import type { ScenarioDetail } from './types';

type Mode = 'guided' | 'advanced' | 'yaml' | 'versions' | 'preview';

/** The manual editor (Guided / Advanced / YAML / Versions / Preview), sharing the draft hook with Scenario Studio. */
export function ClassicEditor({ scenarioId }: { scenarioId: string }) {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const draft = useScenarioDraft(scenarioId);
  const { detail, error, mutate, config, ctx, saveState, saveError, readOnly, issues, save, applyDetail } = draft;
  const key = wsPath(`/scenarios/${scenarioId}`);

  const [mode, setMode] = useState<Mode>('advanced');
  const [showPublish, setShowPublish] = useState(false);
  const [showAssistant, setShowAssistant] = useState(true);
  const [starting, setStarting] = useState(false);
  const [meetingOpen, setMeetingOpen] = useState(false);
  const pickedMode = useRef(false);

  // First load: pick guided mode for brand-new, mostly empty drafts.
  useEffect(() => {
    if (detail && config && !pickedMode.current) {
      pickedMode.current = true;
      if (!detail.latestVersion && !detail.draft.config.persona.role && !detail.draft.config.instructions.goals.length) setMode('guided');
    }
  }, [detail, config]);

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
        body: { changeNote: changeNote || undefined, revision: draft.revision() },
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
      draft.setServerIssues(r.issues);
      draft.markServerChecked(config);
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
      router.push(href(`/scenarios/${d.scenario.id}/studio`));
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
    await draft.resolveConflict(keepMine);
    if (!keepMine) toast.info('Loaded the latest draft');
  };

  return (
    <EditorContext.Provider value={ctx}>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <Link href={href(`/scenarios/${scenarioId}`)} className="text-xs text-slate-500 hover:text-slate-800">
                ← Scenario
              </Link>
              <div role="group" aria-label="Editor mode" className="inline-flex rounded-md border border-slate-300 p-0.5 text-xs">
                <Link href={href(`/scenarios/${scenarioId}/studio`)} aria-pressed="false" className="rounded px-2 py-0.5 text-slate-700 hover:bg-slate-100" onClick={(e) => { e.preventDefault(); void flush().then(() => router.push(href(`/scenarios/${scenarioId}/studio`))); }}>
                  AI Studio
                </Link>
                <span aria-pressed="true" className="rounded bg-brand-600 px-2 py-0.5 font-medium text-white">
                  Legacy
                </span>
              </div>
            </div>
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
                {SAVE_LABELS[saveState]}
              </span>
              <span className="text-slate-400">rev {draft.revision()}</span>
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMeetingOpen(true)}
            disabled={!published || !config.channels.meeting.enabled}
            title={!published ? 'Publish first' : !config.channels.meeting.enabled ? 'Turn on Channels → Meeting bot, then publish' : 'The AI persona joins your Zoom / Google Meet / Teams meeting'}
          >
            Practice in a meeting
          </Button>
        </nav>
        <MeetingPracticeModal open={meetingOpen} onClose={() => setMeetingOpen(false)} wsPath={wsPath} scenarioId={s.id} personaName={config.persona.name} />

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
                  if (!(await draft.replaceConfig(c))) {
                    toast.error(saveState === 'conflict' ? 'The draft changed elsewhere' : 'Could not apply');
                    throw new Error('not applied');
                  }
                  toast.success('Applied');
                }}
              />
            )}
            {mode === 'versions' && <VersionsTab wsPath={wsPath} scenarioId={s.id} canPublish={can('scenarios.publish')} onRolledBack={applyDetail} />}
            {mode === 'preview' && <PreviewTab wsPath={wsPath} scenarioId={s.id} revision={draft.revision()} hasVersion={!!s.latestVersionId} />}
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
