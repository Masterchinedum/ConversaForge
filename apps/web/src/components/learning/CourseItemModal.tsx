'use client';
/** Add / edit a course item (scenario, video, document, link) with its completion rule. */
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { Button, Checkbox, Field, Input, Modal, Select, Textarea, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { KIND_LABEL, type CompletionRule, type ItemKind } from '@/lib/learning';

export interface EditorItem {
  id: string;
  position: number;
  kind: ItemKind;
  title: string;
  description: string | null;
  scenarioId: string | null;
  scenario: { id: string; name: string; runnable: boolean; latestVersionNumber: number } | null;
  pinnedVersionId: string | null;
  pinnedVersion: { id: string; version: number } | null;
  url: string | null;
  assetId: string | null;
  asset: { id: string; fileName: string | null; mimeType: string; sizeBytes: number } | null;
  completionRule: CompletionRule;
  required: boolean;
}

interface ScenarioOption {
  id: string;
  name: string;
  type: string;
  latestVersionNumber: number;
  versions: Array<{ id: string; version: number; publishedAt: string }>;
}

export function CourseItemModal({
  open,
  onClose,
  coursePath,
  item,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  /** API path of the course, e.g. /workspaces/<ws>/courses/<id> */
  coursePath: string;
  /** Existing item to edit; null → add. */
  item: EditorItem | null;
  onSaved: () => void;
}) {
  const toast = useToast();
  const workspaceBase = coursePath.replace(/\/courses\/[^/]+$/, '/courses');
  const { data: scenarios } = useSWR<{ data: ScenarioOption[] }>(open ? `${workspaceBase}/options/scenarios` : null);
  const [kind, setKind] = useState<ItemKind>('SCENARIO');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [scenarioId, setScenarioId] = useState('');
  const [pinnedVersionId, setPinned] = useState('');
  const [source, setSource] = useState<'upload' | 'url'>('url');
  const [url, setUrl] = useState('');
  const [asset, setAsset] = useState<EditorItem['asset']>(null);
  const [ruleType, setRuleType] = useState<CompletionRule['type']>('session_completed');
  const [minScore, setMinScore] = useState(70);
  const [required, setRequired] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind(item?.kind ?? 'SCENARIO');
    setTitle(item?.title ?? '');
    setDescription(item?.description ?? '');
    setScenarioId(item?.scenarioId ?? '');
    setPinned(item?.pinnedVersionId ?? '');
    setSource(item?.assetId ? 'upload' : 'url');
    setUrl(item?.url ?? '');
    setAsset(item?.asset ?? null);
    setRuleType(item?.completionRule.type ?? 'session_completed');
    setMinScore(item?.completionRule.type === 'min_score' ? item.completionRule.minScore : 70);
    setRequired(item?.required ?? true);
  }, [open, item]);

  const changeKind = (k: ItemKind) => {
    setKind(k);
    setRuleType(k === 'SCENARIO' ? 'session_completed' : 'viewed');
    setSource(k === 'LINK' ? 'url' : source);
  };

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api<{ asset: NonNullable<EditorItem['asset']> }>(`${coursePath}/assets`, {
        method: 'POST',
        body: fd,
        query: { purpose: kind === 'VIDEO' ? 'video' : 'document' },
      });
      setAsset(r.asset);
      if (!title) setTitle(r.asset.fileName ?? '');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const rule: CompletionRule = ruleType === 'min_score' ? { type: 'min_score', minScore } : ({ type: ruleType } as CompletionRule);
  const selectedScenario = scenarios?.data.find((s) => s.id === scenarioId);

  const save = async () => {
    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        title: title.trim() || undefined,
        description: description.trim() || null,
        completionRule: rule,
        required,
      };
      if (kind === 'SCENARIO') {
        body.scenarioId = scenarioId;
        body.pinnedVersionId = pinnedVersionId || null;
      } else if (kind === 'LINK' || source === 'url') {
        body.url = url.trim();
        body.assetId = null;
      } else {
        body.assetId = asset?.id ?? null;
        body.url = null;
      }
      if (item) await api(`${coursePath}/items/${item.id}`, { method: 'PATCH', body });
      else await api(`${coursePath}/items`, { method: 'POST', body: { ...body, kind } });
      toast.success(item ? 'Item updated' : 'Item added');
      onSaved();
      onClose();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const canSave =
    kind === 'SCENARIO' ? !!scenarioId : kind === 'LINK' || source === 'url' ? /^https:\/\//.test(url.trim()) && !!title.trim() : !!asset;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={item ? `Edit ${KIND_LABEL[item.kind].toLowerCase()} item` : 'Add item'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!canSave || uploading}>
            {item ? 'Save' : 'Add item'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!item && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-slate-700">Kind</legend>
            <div className="flex flex-wrap gap-2">
              {(['SCENARIO', 'VIDEO', 'DOCUMENT', 'LINK'] as const).map((k) => (
                <Button key={k} size="sm" variant={kind === k ? 'primary' : 'secondary'} onClick={() => changeKind(k)} aria-pressed={kind === k}>
                  {k === 'SCENARIO' ? 'Practice scenario' : KIND_LABEL[k]}
                </Button>
              ))}
            </div>
          </fieldset>
        )}

        {kind === 'SCENARIO' && (
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Scenario" required hint="Only published scenarios of this workspace are listed.">
              {(id) => (
                <Select
                  id={id}
                  value={scenarioId}
                  onChange={(e) => {
                    setScenarioId(e.target.value);
                    setPinned('');
                  }}
                >
                  <option value="">Choose…</option>
                  {scenarios?.data.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                  {item?.scenario && !scenarios?.data.some((s) => s.id === item.scenarioId) && (
                    <option value={item.scenarioId!}>{item.scenario.name} (unavailable)</option>
                  )}
                </Select>
              )}
            </Field>
            <Field label="Version" hint="Pin a version, or always use the latest published one.">
              {(id) => (
                <Select id={id} value={pinnedVersionId} onChange={(e) => setPinned(e.target.value)} disabled={!selectedScenario}>
                  <option value="">Latest published{selectedScenario ? ` (v${selectedScenario.latestVersionNumber})` : ''}</option>
                  {selectedScenario?.versions.map((v) => (
                    <option key={v.id} value={v.id}>
                      v{v.version}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}

        {(kind === 'VIDEO' || kind === 'DOCUMENT') && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-slate-700">Source</legend>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-1">
                <input type="radio" name="source" checked={source === 'upload'} onChange={() => setSource('upload')} /> Upload a file
              </label>
              <label className="flex items-center gap-1">
                <input type="radio" name="source" checked={source === 'url'} onChange={() => setSource('url')} /> https URL
              </label>
            </div>
            {source === 'upload' ? (
              <div className="space-y-1">
                <input
                  ref={fileRef}
                  type="file"
                  aria-label="Choose file"
                  accept={kind === 'VIDEO' ? 'video/mp4,video/webm,video/quicktime' : 'application/pdf'}
                  onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
                  className="text-sm"
                />
                {uploading && <p className="text-xs text-slate-500">Uploading…</p>}
                {asset && (
                  <p className="text-xs text-slate-600">
                    Uploaded: {asset.fileName} ({Math.round(asset.sizeBytes / 1024)} KB)
                  </p>
                )}
                <p className="text-xs text-slate-500">{kind === 'VIDEO' ? 'MP4, WebM or MOV up to 200 MB.' : 'PDF up to 50 MB.'}</p>
              </div>
            ) : null}
          </fieldset>
        )}

        {(kind === 'LINK' || ((kind === 'VIDEO' || kind === 'DOCUMENT') && source === 'url')) && (
          <Field label="URL" required hint="Must start with https://">
            {(id) => <Input id={id} type="url" value={url} placeholder="https://…" onChange={(e) => setUrl(e.target.value)} />}
          </Field>
        )}

        <Field label="Title" required={kind !== 'SCENARIO'} hint={kind === 'SCENARIO' ? 'Defaults to the scenario name.' : undefined}>
          {(id) => <Input id={id} value={title} maxLength={200} onChange={(e) => setTitle(e.target.value)} />}
        </Field>
        <Field label="Description">{(id) => <Textarea id={id} rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />}</Field>

        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Completion rule">
            {(id) => (
              <Select id={id} value={ruleType} onChange={(e) => setRuleType(e.target.value as CompletionRule['type'])}>
                {kind === 'SCENARIO' ? (
                  <>
                    <option value="session_completed">Session completed</option>
                    <option value="min_score">Minimum score</option>
                    <option value="manual">Reviewer marks complete</option>
                  </>
                ) : (
                  <>
                    <option value="viewed">Learner marks as viewed</option>
                    <option value="manual">Reviewer marks complete</option>
                  </>
                )}
              </Select>
            )}
          </Field>
          {ruleType === 'min_score' && (
            <Field label="Minimum overall score (0–100)" hint="Sessions without enough evidence to score do not count.">
              {(id) => (
                <Input id={id} type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} />
              )}
            </Field>
          )}
        </div>
        <Checkbox label="Required" description="Required items count toward progress and, with forced order, unlock the next items." checked={required} onChange={setRequired} />
      </div>
    </Modal>
  );
}
