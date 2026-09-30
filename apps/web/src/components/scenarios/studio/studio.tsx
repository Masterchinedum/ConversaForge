'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { fieldLabel, SCENARIO_TEMPLATES, type ValidationIssue } from '@cf/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useWorkspace } from '@/lib/workspace';
import { Alert, Button, EmptyState, ErrorState, Loading, clsx, useToast } from '@/components/ui';
import { EditorContext, fieldDomId, focusField, lockablePathFor, type EditorCtx } from '../editor-context';
import { NewScenarioModal } from '../new-scenario';
import { PreviewTab, PublishModal, YamlEditor } from '../panels';
import { StatusBadge } from '../status-badge';
import type { Proposal, ScenarioDetail } from '../types';
import { SAVE_LABELS, useScenarioDraft, type ScenarioDraft } from '../use-scenario-draft';
import { StudioChat } from './chat';
import { DeployTab } from './deploy';
import { STUDIO_SECTIONS, StudioForm, sectionForPath, type SectionId } from './form';

type Tab = 'form' | 'yaml' | 'preview' | 'deploy';
type Pane = 'chat' | 'config';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'form', label: 'Form' },
  { id: 'yaml', label: 'YAML / JSON' },
  { id: 'preview', label: 'Preview' },
  { id: 'deploy', label: 'Deploy' },
];

const initialOpen = () => Object.fromEntries(STUDIO_SECTIONS.map((s) => [s.id, s.core])) as Record<SectionId, boolean>;

/**
 * Scenario Studio: the AI conversation on the left and the scenario configuration on the right, both
 * editing the same ScenarioConfig draft. `scenarioId = null` is a brand-new draft that is stored on the
 * first edit or message (the URL then becomes /scenarios/<id>, so a reload comes back to it).
 */
export function ScenarioStudio({ scenarioId: initialId }: { scenarioId: string | null }) {
  const { wsPath, href, can } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const { mutate: globalMutate } = useSWRConfig();
  const draft = useScenarioDraft(initialId, {
    // Keep this page mounted (chat state, focus) while the address bar points at the stored draft.
    onCreated: (id) => window.history.replaceState(window.history.state, '', href(`/scenarios/${id}`)),
  });

  const [tab, setTab] = useState<Tab>('form');
  const [pane, setPane] = useState<Pane>('chat');
  const [open, setOpen] = useState<Record<SectionId, boolean>>(initialOpen);
  const [recent, setRecent] = useState<{ paths: string[]; at: number } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [justCreated, setJustCreated] = useState<number | null>(null);
  const [templatesOpen, setTemplatesOpen] = useState(false);

  const convKey = draft.scenarioId ? ([wsPath(`/scenarios/${draft.scenarioId}/assistant`), { limit: 100 }] as const) : null;
  const { data: conv, mutate: mutateConv } = useSWR<{ data: Proposal[] }>(convKey);
  const proposals = useMemo(() => [...(conv?.data ?? [])].reverse(), [conv]);
  const pendingPaths = useMemo(() => Array.from(new Set(proposals.filter((p) => p.status === 'PENDING').flatMap((p) => p.changes.map((c) => c.path)))), [proposals]);

  useEffect(() => {
    if (!recent) return;
    const t = setTimeout(() => setRecent(null), 6000);
    return () => clearTimeout(t);
  }, [recent]);

  const ctx: EditorCtx | null = useMemo(
    () =>
      draft.ctx && {
        ...draft.ctx,
        // Don't greet a blank new draft with a wall of red; the footer still counts what is missing.
        issues: draft.saveState === 'new' ? [] : draft.ctx.issues,
        aiMark: (path: string) => (pendingPaths.includes(path) ? 'pending' : recent?.paths.includes(path) ? 'updated' : null),
      },
    [draft.ctx, pendingPaths, recent],
  );

  const goto = useCallback((path: string) => {
    const section = sectionForPath(path);
    setTab('form');
    setPane('config');
    setShowIssues(false);
    setOpen((o) => ({ ...o, [section]: true }));
    // Wait for the pane/section to render, then focus (retry once if layout was still settling, e.g. on phones).
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
      // Reveal the sections that changed.
      setOpen((o) => ({ ...o, ...Object.fromEntries(paths.map((p) => [sectionForPath(p), true])) }));
    },
    [draft],
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
    // The preview is compiled from the saved draft: save first so it matches what is on screen.
    if (t === 'preview' && draft.scenarioId) await draft.flush();
  };

  const switchToClassic = async () => {
    if (!(await draft.flush())) {
      toast.error('Save your changes before switching to the classic editor');
      return;
    }
    const id = await draft.ensureCreated();
    router.push(href(`/scenarios/${id}?view=classic`));
  };

  const publish = async (changeNote: string) => {
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
      setJustCreated(r.version.version);
      toast.success(r.version.version === 1 ? 'Scenario created — version 1 is live' : `Published version ${r.version.version}`);
      setTab('deploy');
      setPane('config');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'no_changes') toast.info(e.message);
      else toast.error(errorMessage(e));
    } finally {
      setPublishing(false);
    }
  };

  const primary = () => {
    if (errors.length) {
      setShowIssues(true);
      return;
    }
    if (!created) void publish('Created in Scenario Studio');
    else if (!d?.draftHasUnpublishedChanges && draft.saveState === 'saved') toast.info(`No changes since version ${d?.latestVersion?.version}`);
    else setShowPublish(true);
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

  return (
    <EditorContext.Provider value={ctx}>
      <div className="flex h-full min-h-0 flex-col bg-white" data-testid="scenario-studio">
        {/* Header */}
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <Link href={href('/scenarios')} className="rounded px-2 py-1 text-sm text-slate-600 hover:bg-slate-100 hover:text-slate-900">
              ← Back
            </Link>
            <div className="min-w-0">
              <h1 className="text-base font-semibold text-slate-900">Scenario Studio</h1>
              <p className="flex min-w-0 items-center gap-2 text-xs text-slate-500">
                <span className="truncate" data-testid="scenario-title">
                  {name || 'Untitled scenario'}
                </span>
                {d && <StatusBadge row={{ ...d.scenario, draftHasUnpublishedChanges: d.draftHasUnpublishedChanges }} />}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <SaveStatus draft={draft} />
            <div role="group" aria-label="Editor mode" className="inline-flex rounded-md border border-slate-300 p-0.5 text-sm">
              <button type="button" aria-pressed="true" className="rounded bg-brand-600 px-2.5 py-1 font-medium text-white">
                AI Studio
              </button>
              <button type="button" aria-pressed="false" onClick={switchToClassic} className="rounded px-2.5 py-1 text-slate-700 hover:bg-slate-100">
                Classic
              </button>
            </div>
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
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={clsx('flex-1 px-3 py-2 text-sm font-medium', pane === p ? 'border-b-2 border-brand-600 text-brand-700' : 'text-slate-600')}
            >
              {p === 'chat' ? 'AI chat' : 'Configuration'}
              {p === 'config' && pendingPaths.length > 0 && <span className="ml-1 rounded-full bg-indigo-100 px-1.5 text-xs text-indigo-800">{pendingPaths.length}</span>}
            </button>
          ))}
        </div>

        <div className="flex min-h-0 flex-1">
          <aside aria-label="AI assistant" className={clsx('min-h-0 w-full flex-col border-slate-200 lg:flex lg:w-[26rem] lg:shrink-0 lg:border-r xl:w-[30rem]', pane === 'chat' ? 'flex' : 'hidden')}>
            <StudioChat
              draft={draft}
              proposals={proposals}
              loaded={!draft.scenarioId || !!conv}
              refresh={() => mutateConv()}
              onApplied={onApplied}
              onGoto={goto}
              onOpenTemplates={draft.scenarioId ? undefined : () => setTemplatesOpen(true)}
            />
          </aside>

          <section aria-label="Scenario configuration" className={clsx('min-h-0 min-w-0 flex-1 flex-col lg:flex', pane === 'config' ? 'flex' : 'hidden')}>
            <div role="tablist" aria-label="Configuration views" className="flex shrink-0 gap-1 overflow-x-auto border-b border-slate-200 px-4">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  onClick={() => void openTab(t.id)}
                  className={clsx('whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium', tab === t.id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900')}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50 p-4">
              {tab === 'form' && <StudioForm open={open} onToggle={(id) => setOpen((o) => ({ ...o, [id]: !o[id] }))} issues={draft.issues} pendingPaths={pendingPaths} />}
              {tab === 'yaml' && (
                <YamlEditor
                  config={draft.config}
                  readOnly={draft.readOnly}
                  onApply={async (c) => {
                    if (!(await draft.replaceConfig(c))) throw new Error('not saved');
                    toast.success('Applied to the draft');
                  }}
                />
              )}
              {tab === 'preview' &&
                (draft.scenarioId ? (
                  <div className="space-y-3">
                    <Alert tone="info">This is the current draft as a participant would see it. Previewing never publishes anything.</Alert>
                    <PreviewTab wsPath={wsPath} scenarioId={draft.scenarioId} revision={draft.saveState === 'saved' ? draft.revision() : -1} hasVersion={!!d?.scenario.latestVersionId} />
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">The preview appears once the draft has content. Describe your scenario or edit a field first.</p>
                ))}
              {tab === 'deploy' && <DeployTab draft={draft} justCreated={justCreated} />}
            </div>
          </section>
        </div>

        {/* Sticky footer */}
        <footer className="relative flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-slate-200 bg-white px-4 py-2.5">
          <div className="flex min-w-0 flex-wrap items-center gap-3 text-sm">
            <SaveStatus draft={draft} compact />
            {errors.length > 0 ? (
              <button type="button" className="font-medium text-red-700 underline decoration-dotted" aria-expanded={showIssues} onClick={() => setShowIssues((v) => !v)} data-testid="issues-toggle">
                {errors.length} {errors.length === 1 ? 'field needs' : 'fields need'} attention
              </button>
            ) : (
              <span className="text-emerald-700" data-testid="ready">
                Ready to {created ? 'publish' : 'create'}
                {warnings.length ? ` · ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}
              </span>
            )}
          </div>
          <Button onClick={primary} loading={publishing} disabled={errors.length > 0 || !canPublish || archived || draft.readOnly} title={!canPublish ? 'Ask an admin for permission to publish' : archived ? 'Unarchive this scenario first' : errors.length ? 'Fix the fields listed on the left first' : undefined} data-testid="studio-primary">
            {created ? 'Publish Changes' : 'Create Scenario'}
          </Button>
          {showIssues && errors.length > 0 && <IssuesPanel issues={draft.issues} onGoto={goto} onClose={() => setShowIssues(false)} />}
        </footer>
      </div>
      <PublishModal open={showPublish} onClose={() => setShowPublish(false)} issues={draft.issues} onPublish={publish} latestVersion={d?.scenario.latestVersionNumber ?? 0} />
      <NewScenarioModal open={templatesOpen} onClose={() => setTemplatesOpen(false)} wsPath={wsPath} href={href} initialTemplate={SCENARIO_TEMPLATES[0]?.key} />
    </EditorContext.Provider>
  );
}

function SaveStatus({ draft, compact }: { draft: ScenarioDraft; compact?: boolean }) {
  const s = draft.saveState;
  return (
    <span
      aria-live="polite"
      data-testid={compact ? 'save-state-footer' : 'save-state'}
      className={clsx('whitespace-nowrap text-xs', s === 'error' || s === 'conflict' ? 'font-medium text-red-700' : s === 'saved' ? 'text-emerald-700' : 'text-slate-500', compact && 'hidden sm:inline')}
    >
      {s === 'new' ? 'New draft — saved when you start' : SAVE_LABELS[s]}
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
