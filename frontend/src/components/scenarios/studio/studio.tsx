'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { fieldLabel, getAtPath, SCENARIO_TEMPLATES, stableStringify, type ValidationIssue } from '@/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, EmptyState, ErrorState, Loading, Spinner, clsx, useToast } from '@/components/ui';
import { EditorContext, fieldDomId, focusField, lockablePathFor, type EditorCtx } from '../editor-context';
import { Icon, type IconName } from '../icons';
import { NewScenarioModal } from '../new-scenario';
import { PublishModal, YamlEditor } from '../panels';
import type { Proposal, ScenarioDetail } from '../types';
import { SAVE_LABELS, useScenarioDraft, type ScenarioDraft } from '../use-scenario-draft';
import { StudioChat, startAgentRun, type AgentMode } from './chat';
import { DeployTab } from './deploy';
import { STUDIO_SECTIONS, StudioForm, sectionForPath, type SectionId } from './form';
import { StudioPreview } from './preview';

type Tab = 'form' | 'yaml' | 'preview' | 'deploy';
type Pane = 'chat' | 'config';

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'form', label: 'Form', icon: 'doc' },
  { id: 'yaml', label: 'YAML', icon: 'code' },
  { id: 'preview', label: 'Preview', icon: 'eye' },
  { id: 'deploy', label: 'Deploy', icon: 'rocket' },
];

const initialOpen = (): Record<SectionId, boolean> => ({ core: true, rubric: true, behavior: false, feedback: false, post: false, conversation: false, tools: false, more: false });
const APPLIED = new Set(['APPLIED', 'PARTIAL', 'DONE', 'CANCELLED', 'FAILED']);

/**
 * Scenario Studio (full screen): the AI conversation on the left and the configuration on the right,
 * both editing the same ScenarioConfig draft. A message starts an agent run that edits the draft in
 * visible steps (polled); the form is read-only while it works. `scenarioId = null` is a new draft that
 * is stored on the first edit or message (the URL then moves to /scenarios/<id>/studio).
 */
export function ScenarioStudio({ scenarioId: initialId }: { scenarioId: string | null }) {
  const { wsPath, href, can, me } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();
  const draft = useScenarioDraft(initialId, {
    onCreated: (id) => window.history.replaceState(window.history.state, '', href(`/scenarios/${id}/studio`)),
  });

  const [tab, setTab] = useState<Tab>('form');
  const [pane, setPane] = useState<Pane>('chat');
  const [chatHidden, setChatHidden] = useState(false);
  const [open, setOpen] = useState<Record<SectionId, boolean>>(initialOpen);
  const [recent, setRecent] = useState<{ paths: string[]; at: number } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [starting, setStarting] = useState<string | null>(null);

  const convKey = draft.scenarioId ? ([wsPath(`/scenarios/${draft.scenarioId}/assistant`), { limit: 100 }] as const) : null;
  const [polling, setPolling] = useState(false);
  const { data: conv, mutate: mutateConv } = useSWR<{ data: Proposal[] }>(convKey, { refreshInterval: polling || starting ? 1200 : 0 });
  const proposals = useMemo(() => [...(conv?.data ?? [])].reverse(), [conv]);
  const running = proposals.find((p) => p.status === 'RUNNING') ?? null;
  const working = !!running || !!starting;
  useEffect(() => setPolling(!!running), [running]);

  // Pull the draft from the server as the agent writes it (the form is read-only meanwhile).
  const seen = useRef<string>('');
  useEffect(() => {
    const latest = proposals.filter((p) => p.mode !== 'review').slice(-1)[0];
    if (!latest || !draft.scenarioId) return;
    const sig = `${latest.id}:${latest.status}:${latest.appliedPaths.length}`;
    if (sig === seen.current) return;
    const firstLook = !seen.current;
    seen.current = sig;
    if (firstLook && latest.status !== 'RUNNING') return;
    void api<ScenarioDetail>(wsPath(`/scenarios/${draft.scenarioId}`)).then((d) => draft.applyDetail(d));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals]);

  useEffect(() => {
    if (!recent) return;
    const t = setTimeout(() => setRecent(null), 6000);
    return () => clearTimeout(t);
  }, [recent]);

  // Which fields still hold the value the assistant last wrote (✓), which it is writing now, which await review.
  const pendingPaths = useMemo(() => Array.from(new Set(proposals.filter((p) => p.status === 'PENDING').flatMap((p) => p.changes.map((c) => c.path)))), [proposals]);
  const aiValues = useMemo(() => {
    const m = new Map<string, string>();
    for (let i = proposals.length - 1; i >= 0; i--) {
      const p = proposals[i]!;
      if (!APPLIED.has(p.status)) continue;
      for (const c of p.changes) if (p.appliedPaths.includes(c.path) && !m.has(c.path)) m.set(c.path, stableStringify(c.after ?? null));
    }
    return m;
  }, [proposals]);
  const config = draft.config;
  const ctx: EditorCtx | null = useMemo(
    () =>
      draft.ctx && {
        ...draft.ctx,
        readOnly: draft.ctx.readOnly || working,
        issues: draft.saveState === 'new' ? [] : draft.ctx.issues,
        aiMark: (path: string) => {
          if (running?.appliedPaths.includes(path)) return 'working';
          if (pendingPaths.includes(path)) return 'pending';
          if (recent?.paths.includes(path)) return 'updated';
          const v = aiValues.get(path);
          return v !== undefined && config && v === stableStringify(getAtPath(config, path) ?? null) ? 'ai' : null;
        },
      },
    [draft.ctx, draft.saveState, working, running, pendingPaths, recent, aiValues, config],
  );

  const goto = useCallback((path: string) => {
    const section = sectionForPath(path);
    setTab('form');
    setPane('config');
    setShowIssues(false);
    setOpen((o) => ({ ...o, [section]: true }));
    const attempt = (retry: boolean) => {
      const target = document.getElementById(fieldDomId(path));
      if (target && target.contains(document.activeElement)) return;
      if (!focusField(path)) document.getElementById(`studio-sec-${section}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (retry) setTimeout(() => attempt(false), 250);
    };
    setTimeout(() => attempt(true), 80);
  }, []);

  const onApplied = useCallback(
    (d: ScenarioDetail, paths: string[]) => {
      draft.applyDetail(d);
      setRecent({ paths, at: Date.now() });
      setOpen((o) => ({ ...o, ...Object.fromEntries(paths.map((p) => [sectionForPath(p), true])) }));
    },
    [draft],
  );

  const askAgent = useCallback(
    async (instruction: string, mode: AgentMode) => {
      setStarting(instruction);
      try {
        await startAgentRun(draft, wsPath, instruction, mode);
        await mutateConv();
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setStarting(null);
      }
    },
    [draft, wsPath, mutateConv, toast],
  );

  const errors = draft.issues.filter((i) => i.severity === 'error');
  const warnings = draft.issues.filter((i) => i.severity === 'warning');
  const d = draft.detail;
  const created = !!d?.latestVersion;
  const archived = d?.scenario.status === 'ARCHIVED';
  const canPublish = can('scenarios.publish');

  const openTab = async (t: Tab) => {
    setTab(t);
    setPane('config');
    if (t === 'preview' && draft.scenarioId) await draft.flush();
  };

  const switchToLegacy = async () => {
    if (!(await draft.flush())) {
      toast.error('Save your changes before switching to the legacy editor');
      return;
    }
    const id = await draft.ensureCreated();
    router.push(href(`/scenarios/${id}/legacy`));
  };

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const publish = async (changeNote: string, first: boolean) => {
    setPublishing(true);
    try {
      if (!(await draft.flush())) throw new Error('Your latest changes are not saved yet. Resolve the save problem and try again.');
      const id = await draft.ensureCreated();
      const r = await api<{ version: { version: number }; scenario: ScenarioDetail }>(wsPath(`/scenarios/${id}/publish`), {
        method: 'POST',
        body: { changeNote: changeNote || undefined, revision: draft.revision() },
      });
      draft.applyDetail(r.scenario);
      void globalMutate(wsPath(`/scenarios/${id}/versions`));
      setShowPublish(false);
      if (first) {
        toast.success('Scenario created — version 1 is live');
        router.push(href(`/scenarios/${id}`));
      } else {
        toast.success(`Saved — version ${r.version.version} is live for new sessions`);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_changes') toast.info(e.message);
      else toast.error(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  const discardDraft = async () => {
    setMenuOpen(false);
    if (!draft.scenarioId || !d?.latestVersion) return;
    if (!window.confirm(`Discard all changes since version ${d.latestVersion.version}? The draft goes back to the published version.`)) return;
    try {
      const r = await api<ScenarioDetail>(wsPath(`/scenarios/${draft.scenarioId}/draft/revert`), { method: 'POST', body: { revision: draft.revision() } });
      draft.applyDetail(r);
      toast.success('Draft reset to the published version');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  const primary = () => {
    if (errors.length) return setShowIssues(true);
    if (!created) return void publish('Created in Scenario Studio', true);
    if (!d?.draftHasUnpublishedChanges && draft.saveState === 'saved') return toast.info(`No changes since version ${d?.latestVersion?.version}`);
    void publish('Updated in Scenario Studio', false);
  };

  if (!can('scenarios.edit')) return <ErrorState error={new Error('Only creators can edit scenarios.')} />;
  if (draft.error instanceof ApiError && draft.error.status === 404)
    return (
      <div className="p-6">
        <EmptyState
          title="Scenario not found"
          description="It may have been deleted, or it belongs to another workspace."
          action={
            <Link className="text-brand-700 hover:underline" href={href('/scenarios')}>
              Back to scenarios
            </Link>
          }
        />
      </div>
    );
  if (draft.error) return <ErrorState error={draft.error} retry={() => draft.mutate()} />;
  if (!ctx || !draft.config) return <Loading />;

  const name = draft.config.basics.name.trim();
  const back = draft.scenarioId && created ? href(`/scenarios/${draft.scenarioId}`) : href('/scenarios');
  const initials =
    (me.user.name ?? me.user.email)
      .replace(/[^\p{L} ]/gu, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .slice(0, 2)
      .toUpperCase() || 'YOU';

  return (
    <EditorContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col bg-white" data-testid="scenario-studio">
        {/* Header */}
        <header className="grid shrink-0 grid-cols-[auto_1fr_auto] items-center gap-2 border-b border-slate-200 px-3 py-2">
          <div className="flex items-center gap-1">
            <Link href={href('/')} aria-label="Home" className="rounded p-2 text-slate-600 hover:bg-slate-100">
              <Icon name="home" />
            </Link>
            <Link href={back} className="flex items-center gap-1.5 rounded px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
              <Icon name="back" /> Back
            </Link>
          </div>
          <h1 className="truncate text-center text-base font-semibold text-slate-900 sm:text-lg">
            Scenario Studio
            {name && (
              <span className="font-normal text-slate-500">
                {' · '}
                <span data-testid="scenario-title">{name}</span>
              </span>
            )}
          </h1>
          <div className="flex items-center gap-1.5">
            <div role="group" aria-label="Editor mode" className="hidden items-center gap-1 sm:flex">
              <button type="button" aria-pressed="true" className="flex items-center gap-1.5 rounded-md border border-brand-300 bg-brand-50 px-2.5 py-1.5 text-sm font-medium text-brand-700">
                <Icon name="chat" /> AI Studio
              </button>
              <button type="button" aria-pressed="false" onClick={switchToLegacy} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1.5 text-sm text-slate-700 hover:bg-slate-50">
                <Icon name="grid" /> Legacy
              </button>
            </div>
            <button type="button" onClick={() => setChatHidden((v) => !v)} aria-pressed={chatHidden} aria-label={chatHidden ? 'Show the AI chat' : 'Hide the AI chat'} title={chatHidden ? 'Show chat' : 'Hide chat'} className="hidden rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 lg:block">
              <Icon name="panel" />
            </button>
            <button type="button" onClick={toggleFullscreen} aria-label="Full screen" title="Full screen" className="hidden rounded-md border border-slate-200 p-1.5 text-slate-600 hover:bg-slate-50 sm:block">
              <Icon name="expand" />
            </button>
          </div>
        </header>

        {draft.saveState === 'conflict' && (
          <div className="shrink-0 px-4 pt-3">
            <Alert tone="error" title="This draft was changed somewhere else">
              <p>Someone (or another tab) saved a newer revision. Your edits are still on screen; choose which version to keep.</p>
              <div className="mt-2 flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => draft.resolveConflict(false)}>
                  Load latest (discard mine)
                </Button>
                <Button size="sm" variant="danger" onClick={() => draft.resolveConflict(true)}>
                  Overwrite with mine
                </Button>
              </div>
            </Alert>
          </div>
        )}
        {draft.saveState === 'error' && (
          <div className="shrink-0 px-4 pt-3">
            <Alert tone="error" title="Your changes are not saved">
              <p>{draft.saveError}</p>
              <p className="text-xs">They are kept on this page. Fix the problem or retry.</p>
              <Button size="sm" variant="secondary" className="mt-2" onClick={() => void draft.save()}>
                Retry saving
              </Button>
            </Alert>
          </div>
        )}

        {/* Narrow screens: switch between the chat and the configuration (both stay mounted). */}
        <div className="flex shrink-0 border-b border-slate-200 lg:hidden" role="tablist" aria-label="Studio panes">
          {(['chat', 'config'] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={clsx('flex-1 px-3 py-2 text-sm font-medium', pane === p ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-600')}>
              {p === 'chat' ? 'AI chat' : 'Configuration'}
              {p === 'chat' && working && <Spinner className="ml-1.5 inline h-3 w-3" />}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          <aside
            aria-label="AI assistant"
            className={clsx('min-h-0 w-full flex-col border-slate-200 lg:w-[27rem] lg:shrink-0 lg:border-r xl:w-[31rem]', pane === 'chat' ? 'flex' : 'hidden', chatHidden ? 'lg:hidden' : 'lg:flex')}
          >
            <StudioChat
              draft={draft}
              proposals={proposals}
              loaded={!draft.scenarioId || !!conv}
              refresh={() => mutateConv()}
              starting={starting}
              setStarting={setStarting}
              onApplied={onApplied}
              onGoto={goto}
              onOpenTemplates={() => setTemplatesOpen(true)}
              userInitials={initials}
            />
          </aside>

          <section aria-label="Scenario configuration" className={clsx('min-h-0 min-w-0 flex-1 flex-col lg:flex', pane === 'config' ? 'flex' : 'hidden')}>
            <div role="tablist" aria-label="Configuration views" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-4">
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => void openTab(t.id)}
                  className={clsx('flex items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2.5 text-sm font-medium', tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900', i === 2 && 'ml-3')}
                >
                  <Icon name={t.icon} /> {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-white p-4 lg:px-6">
              {working && tab === 'form' && (
                <div className="mb-4 flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900" role="status" data-testid="agent-editing">
                  <Spinner className="h-4 w-4" /> The assistant is editing this scenario. Fields update as it works; stop it to edit them yourself.
                </div>
              )}
              {tab === 'form' && <StudioForm open={open} onToggle={(id) => setOpen((o) => ({ ...o, [id]: !o[id] }))} issues={ctx.issues} pendingPaths={pendingPaths} onAgent={askAgent} agentBusy={working || draft.readOnly} />}
              {tab === 'yaml' && (
                <YamlEditor
                  config={draft.config}
                  readOnly={ctx.readOnly}
                  onApply={async (c) => {
                    if (!(await draft.replaceConfig(c))) throw new Error('not saved');
                    toast.success('Applied to the draft');
                  }}
                />
              )}
              {tab === 'preview' && <StudioPreview draft={draft} />}
              {tab === 'deploy' && <DeployTab draft={draft} />}
            </div>
          </section>
        </div>

        {/* Sticky footer */}
        <footer className="relative flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
            <SaveStatus draft={draft} />
            {errors.length > 0 && draft.saveState !== 'new' && (
              <button type="button" className="font-medium text-red-700 underline decoration-dotted" aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)} data-testid="issues-toggle">
                {errors.length} {errors.length === 1 ? 'field needs' : 'fields need'} attention
              </button>
            )}
            {!errors.length && warnings.length > 0 && <span className="text-xs text-amber-700">{warnings.length} warning{warnings.length === 1 ? '' : 's'}</span>}
          </div>
          {working ? (
            <Button disabled data-testid="studio-primary">
              <Spinner className="h-4 w-4" /> Wait for Agent
            </Button>
          ) : !created ? (
            <Button onClick={primary} loading={publishing} disabled={errors.length > 0 || !canPublish || archived || draft.readOnly} title={!canPublish ? 'Ask an admin for permission to publish' : errors.length ? 'Fix the fields listed on the left first' : 'Publish version 1'} data-testid="studio-primary">
              <Icon name="doc" /> Create Scenario
            </Button>
          ) : (
            <div className="relative flex">
              <Button
                onClick={primary}
                loading={publishing}
                disabled={errors.length > 0 || !canPublish || archived || draft.readOnly}
                className="rounded-r-none"
                title={`Publish the draft as version ${(d?.scenario.latestVersionNumber ?? 0) + 1}; running sessions keep their version`}
                data-testid="studio-primary"
              >
                <Icon name="doc" /> Save Changes
              </Button>
              <Button aria-label="More save options" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)} disabled={!canPublish || archived || draft.readOnly} className="rounded-l-none border-l border-white/30 px-2">
                <Icon name="chevronDown" />
              </Button>
              {menuOpen && (
                <div role="menu" className="absolute bottom-full right-0 z-20 mb-2 w-64 rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
                  <button
                    type="button"
                    role="menuitem"
                    className="block w-full px-3 py-2 text-left hover:bg-slate-50 disabled:text-slate-400"
                    disabled={errors.length > 0}
                    onClick={() => {
                      setMenuOpen(false);
                      setShowPublish(true);
                    }}
                  >
                    Save with a change note…
                  </button>
                  <button type="button" role="menuitem" className="block w-full px-3 py-2 text-left text-red-700 hover:bg-red-50" onClick={discardDraft}>
                    Discard unpublished changes
                  </button>
                </div>
              )}
            </div>
          )}
          {showIssues && errors.length > 0 && <IssuesPanel issues={draft.issues} onGoto={goto} onClose={() => setShowIssues(false)} />}
        </footer>
      </div>
      <PublishModal open={showPublish} onClose={() => setShowPublish(false)} issues={draft.issues} onPublish={(note) => publish(note, false)} latestVersion={d?.scenario.latestVersionNumber ?? 0} />
      <NewScenarioModal open={templatesOpen} onClose={() => setTemplatesOpen(false)} wsPath={wsPath} href={href} initialTemplate={SCENARIO_TEMPLATES[0]?.key} />
    </EditorContext.Provider>
  );
}

function SaveStatus({ draft }: { draft: ScenarioDraft }) {
  const s = draft.saveState;
  return (
    <span aria-live="polite" data-testid="save-state" className={clsx('flex items-center gap-1.5 whitespace-nowrap', s === 'error' || s === 'conflict' ? 'font-medium text-red-700' : s === 'saved' ? 'text-slate-800' : 'text-slate-600')}>
      {s === 'saved' ? <span className="text-emerald-600">✓</span> : s === 'dirty' ? <span className="h-2 w-2 rounded-full bg-amber-500" /> : s === 'saving' ? <Spinner className="h-3 w-3" /> : null}
      {s === 'new' ? 'New draft — saved when you start' : s === 'saved' ? 'All saved' : SAVE_LABELS[s]}
    </span>
  );
}

/** Blocking errors, each linking to its field. */
function IssuesPanel({ issues, onGoto, onClose }: { issues: ValidationIssue[]; onGoto: (path: string) => void; onClose: () => void }) {
  const errors = issues.filter((i) => i.severity === 'error');
  return (
    <div role="dialog" aria-label="Fields that need attention" className="absolute bottom-full left-4 right-4 z-20 mb-2 max-h-80 overflow-y-auto rounded-lg border border-red-200 bg-white p-3 shadow-lg sm:right-auto sm:w-[28rem]" data-testid="issues-panel">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm font-semibold text-slate-900">Fix these to continue</p>
        <button type="button" className="text-xs text-slate-500 hover:text-slate-900" onClick={onClose}>
          Close
        </button>
      </div>
      <ul className="space-y-1">
        {errors.map((i, k) => {
          const section = STUDIO_SECTIONS.find((s) => s.id === sectionForPath(i.path));
          const field = lockablePathFor(i.path);
          return (
            <li key={k}>
              <button type="button" className="w-full rounded px-2 py-1.5 text-left text-sm hover:bg-red-50" onClick={() => onGoto(i.path)}>
                <span className="font-medium text-red-800">{field ? fieldLabel(field) : i.path || 'Configuration'}</span>
                <span className="text-slate-500"> · {section?.title}</span>
                <span className="block text-xs text-slate-700">{i.message}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
