'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { SCENARIO_TEMPLATES, SCENARIO_TYPE_LABELS, SCENARIO_TYPES, type ScenarioType } from '@cf/shared';
import { api, errorMessage } from '@/lib/api';
import { Alert, Button, Field, Input, Modal, Select, Tabs, Textarea, clsx } from '@/components/ui';
import type { ScenarioDetail } from './types';

type Mode = 'blank' | 'template' | 'import';

export function NewScenarioModal({ open, onClose, wsPath, href, initialTemplate }: { open: boolean; onClose: () => void; wsPath: (p: string) => string; href: (p: string) => string; initialTemplate?: string }) {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(initialTemplate ? 'template' : 'blank');
  const [name, setName] = useState('');
  const [type, setType] = useState<ScenarioType>('custom');
  const [templateKey, setTemplateKey] = useState(initialTemplate ?? SCENARIO_TEMPLATES[0]!.key);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body =
        mode === 'blank'
          ? { source: 'blank', name: name.trim(), type }
          : mode === 'template'
            ? { source: 'template', templateKey, ...(name.trim() ? { name: name.trim() } : {}) }
            : { source: 'import', text, format: 'auto', ...(name.trim() ? { name: name.trim() } : {}) };
      const d = await api<ScenarioDetail>(wsPath('/scenarios'), { method: 'POST', body });
      onClose();
      router.push(href(`/scenarios/${d.scenario.id}`));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const canSubmit = mode === 'blank' ? name.trim().length > 0 : mode === 'import' ? text.trim().length > 0 : !!templateKey;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New scenario"
      wide
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            Create
          </Button>
        </>
      }
    >
      <Tabs
        tabs={[
          { id: 'blank' as Mode, label: 'Blank' },
          { id: 'template' as Mode, label: 'From template' },
          { id: 'import' as Mode, label: 'Import YAML/JSON' },
        ]}
        value={mode}
        onChange={setMode}
      />
      <div className="space-y-4">
        {mode === 'template' && (
          <div role="radiogroup" aria-label="Template" className="grid gap-2 sm:grid-cols-2">
            {SCENARIO_TEMPLATES.map((t) => (
              <button
                key={t.key}
                type="button"
                role="radio"
                aria-checked={templateKey === t.key}
                onClick={() => setTemplateKey(t.key)}
                className={clsx('rounded-md border p-3 text-left text-sm', templateKey === t.key ? 'border-brand-600 bg-brand-50' : 'border-slate-200 hover:bg-slate-50')}
              >
                <span className="block font-medium">{t.name}</span>
                <span className="block text-xs text-slate-600">{t.summary}</span>
              </button>
            ))}
          </div>
        )}
        {mode === 'import' && (
          <Field label="Paste YAML or JSON" hint="Imported as plain data (max 200 KB) and validated. Nothing in the file is executed.">
            {(id) => (
              <>
                <Textarea id={id} rows={12} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
                <input
                  type="file"
                  accept=".yaml,.yml,.json,text/yaml,application/json"
                  aria-label="Upload a YAML or JSON file"
                  className="mt-2 text-xs"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    if (f.size > 200 * 1024) return setError('File is larger than 200 KB');
                    setText(await f.text());
                  }}
                />
              </>
            )}
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={mode === 'blank' ? 'Name' : 'Name (optional)'} required={mode === 'blank'}>
            {(id) => <Input id={id} value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />}
          </Field>
          {mode === 'blank' && (
            <Field label="Type">
              {(id) => (
                <Select id={id} value={type} onChange={(e) => setType(e.target.value as ScenarioType)}>
                  {SCENARIO_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {SCENARIO_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        {error && <Alert tone="error">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** Create a member self-run session (workstream B) and open the live page. */
export async function startSelfRun(wsPath: (p: string) => string, scenarioId: string): Promise<string> {
  const r = await api<{ sessionId: string; sessionToken: string }>(wsPath(`/scenarios/${scenarioId}/sessions`), { method: 'POST', body: {} });
  try {
    sessionStorage.setItem(`cf:session:${r.sessionId}`, r.sessionToken);
    localStorage.setItem(`cf:session:${r.sessionId}`, r.sessionToken);
  } catch {
    /* storage unavailable */
  }
  return `/live/${r.sessionId}`;
}
