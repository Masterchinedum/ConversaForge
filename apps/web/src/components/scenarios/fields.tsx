'use client';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { EDITABLE_FIELD_PATHS } from '@cf/shared';
import { Button, Checkbox, Input, Select, Textarea, clsx } from '@/components/ui';
import { fieldDomId, issuesFor, useEditor, useField } from './editor-context';

const LOCKABLE = new Set<string>(EDITABLE_FIELD_PATHS);

/** Lock toggle: locked fields are never changed by the drafting assistant. */
export function LockButton({ path }: { path: string }) {
  const { lockedFields, toggleLock, readOnly } = useEditor();
  if (!LOCKABLE.has(path)) return null;
  const locked = lockedFields.includes(path);
  return (
    <button
      type="button"
      onClick={() => toggleLock(path)}
      disabled={readOnly}
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${path} for the drafting assistant` : `Lock ${path} so the drafting assistant cannot change it`}
      title={locked ? 'Locked — the drafting assistant will not change this field. Click to unlock.' : 'Lock this field so the drafting assistant cannot change it'}
      className={clsx(
        'inline-flex h-6 w-6 items-center justify-center rounded text-xs',
        locked ? 'bg-amber-100 text-amber-800' : 'text-slate-400 hover:bg-slate-100 hover:text-slate-700',
      )}
      data-testid={`lock-${path}`}
    >
      {locked ? '🔒' : '🔓'}
    </button>
  );
}

export function FieldRow({
  path,
  label,
  hint,
  required,
  children,
  className,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  required?: boolean;
  children: (id: string) => ReactNode;
  className?: string;
}) {
  const id = useId();
  const { issues } = useEditor();
  const own = issues.filter((i) => i.path === path);
  const err = own.find((i) => i.severity === 'error');
  const warn = own.find((i) => i.severity === 'warning');
  return (
    <div id={fieldDomId(path)} className={clsx('space-y-1 rounded-md transition', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="block text-sm font-medium text-slate-700">
          {label}
          {required && <span className="ml-0.5 text-red-600" aria-hidden>*</span>}
        </label>
        <LockButton path={path} />
      </div>
      {children(id)}
      {err ? (
        <p className="text-xs text-red-600">{err.message}</p>
      ) : warn ? (
        <p className="text-xs text-amber-700">{warn.message}</p>
      ) : hint ? (
        <p className="text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

export function TextField({ path, label, hint, required, placeholder, maxLength }: { path: string; label: ReactNode; hint?: ReactNode; required?: boolean; placeholder?: string; maxLength?: number }) {
  const [v, set] = useField<string>(path);
  const { readOnly, issues } = useEditor();
  return (
    <FieldRow path={path} label={label} hint={hint} required={required}>
      {(id) => (
        <Input id={id} value={v ?? ''} placeholder={placeholder} maxLength={maxLength} disabled={readOnly} aria-invalid={issues.some((i) => i.path === path && i.severity === 'error')} onChange={(e) => set(e.target.value)} />
      )}
    </FieldRow>
  );
}

export function TextAreaField({ path, label, hint, required, rows = 4, placeholder }: { path: string; label: ReactNode; hint?: ReactNode; required?: boolean; rows?: number; placeholder?: string }) {
  const [v, set] = useField<string>(path);
  const { readOnly, issues } = useEditor();
  return (
    <FieldRow path={path} label={label} hint={hint} required={required}>
      {(id) => (
        <Textarea id={id} rows={rows} value={v ?? ''} placeholder={placeholder} disabled={readOnly} aria-invalid={issues.some((i) => i.path === path && i.severity === 'error')} onChange={(e) => set(e.target.value)} />
      )}
    </FieldRow>
  );
}

/** Number input that keeps the raw text while typing and only commits valid numbers. */
export function NumberField({ path, label, hint, min, max, step, optional }: { path: string; label: ReactNode; hint?: ReactNode; min?: number; max?: number; step?: number; optional?: boolean }) {
  const [v, set] = useField<number | undefined>(path);
  const { readOnly } = useEditor();
  const [text, setText] = useState(v === undefined || v === null ? '' : String(v));
  useEffect(() => {
    setText((t) => (Number(t) === v && t !== '' ? t : v === undefined || v === null ? '' : String(v)));
  }, [v]);
  return (
    <FieldRow path={path} label={label} hint={hint}>
      {(id) => (
        <Input
          id={id}
          type="number"
          inputMode="decimal"
          value={text}
          min={min}
          max={max}
          step={step}
          disabled={readOnly}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value === '') {
              if (optional) set(undefined);
              return;
            }
            const n = Number(e.target.value);
            if (Number.isFinite(n)) set(n);
          }}
        />
      )}
    </FieldRow>
  );
}

export function SelectField({ path, label, hint, options }: { path: string; label: ReactNode; hint?: ReactNode; options: ReadonlyArray<{ value: string; label: string } | string> }) {
  const [v, set] = useField<string>(path);
  const { readOnly } = useEditor();
  return (
    <FieldRow path={path} label={label} hint={hint}>
      {(id) => (
        <Select id={id} value={v ?? ''} disabled={readOnly} onChange={(e) => set(e.target.value)}>
          {options.map((o) => {
            const opt = typeof o === 'string' ? { value: o, label: o } : o;
            return (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            );
          })}
        </Select>
      )}
    </FieldRow>
  );
}

export function ToggleField({ path, label, description }: { path: string; label: ReactNode; description?: ReactNode }) {
  const [v, set] = useField<boolean>(path);
  const { readOnly } = useEditor();
  return (
    <div id={fieldDomId(path)} className="flex items-start justify-between gap-2 rounded-md">
      <Checkbox label={label} description={description} checked={!!v} disabled={readOnly} onChange={set} />
      <LockButton path={path} />
    </div>
  );
}

/** Editable list of short strings (goals, boundaries, enum values). */
export function StringListField({ path, label, hint, required, placeholder, addLabel = 'Add' }: { path: string; label: ReactNode; hint?: ReactNode; required?: boolean; placeholder?: string; addLabel?: string }) {
  const [v, set] = useField<string[]>(path);
  const { readOnly } = useEditor();
  const items = v ?? [];
  return (
    <FieldRow path={path} label={label} hint={hint} required={required}>
      {(id) => (
        <div className="space-y-2">
          {items.map((item, i) => (
            <div key={i} className="flex gap-2" id={fieldDomId(`${path}.${i}`)}>
              <Input
                id={i === 0 ? id : undefined}
                aria-label={`${typeof label === 'string' ? label : 'Item'} ${i + 1}`}
                value={item}
                placeholder={placeholder}
                disabled={readOnly}
                onChange={(e) => set(items.map((x, j) => (j === i ? e.target.value : x)))}
              />
              <Button variant="ghost" size="sm" disabled={readOnly} aria-label="Remove" onClick={() => set(items.filter((_, j) => j !== i))}>
                ✕
              </Button>
            </div>
          ))}
          <Button id={items.length ? undefined : id} variant="secondary" size="sm" disabled={readOnly} onClick={() => set([...items, ''])}>
            + {addLabel}
          </Button>
        </div>
      )}
    </FieldRow>
  );
}

/** Comma-separated tags. */
export function TagsField({ path, label }: { path: string; label: ReactNode }) {
  const [v, set] = useField<string[]>(path);
  const { readOnly } = useEditor();
  const [text, setText] = useState((v ?? []).join(', '));
  useEffect(() => {
    const cur = text.split(',').map((t) => t.trim()).filter(Boolean);
    if (cur.join('|') !== (v ?? []).join('|')) setText((v ?? []).join(', '));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v]);
  return (
    <FieldRow path={path} label={label} hint="Comma separated">
      {(id) => (
        <Input
          id={id}
          value={text}
          disabled={readOnly}
          onChange={(e) => {
            setText(e.target.value);
            set(e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 20));
          }}
        />
      )}
    </FieldRow>
  );
}

/** JSON object editor (tool config). Commits only valid JSON objects. */
export function JsonObjectInput({ value, onChange, label, disabled }: { value: Record<string, unknown>; onChange: (v: Record<string, unknown>) => void; label: string; disabled?: boolean }) {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <div>
      <Textarea
        aria-label={label}
        rows={3}
        className="font-mono text-xs"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const parsed = JSON.parse(e.target.value || '{}');
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Must be a JSON object');
            setError(null);
            onChange(parsed);
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      />
      {error && <p className="text-xs text-red-600">{error}</p>}
    </div>
  );
}

export function SectionIssues({ path }: { path: string }) {
  const { issues } = useEditor();
  const list = issuesFor(issues, path).filter((i) => i.path !== path);
  if (!list.length) return null;
  return (
    <ul className="space-y-0.5 text-xs">
      {list.slice(0, 6).map((i, k) => (
        <li key={k} className={i.severity === 'error' ? 'text-red-600' : 'text-amber-700'}>
          {i.path}: {i.message}
        </li>
      ))}
    </ul>
  );
}

/** Snake-case a variable key as the user types. */
export function toKey(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .slice(0, 48);
}

export function toSlugId(s: string) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function newId(prefix: string, existing: string[]) {
  for (let i = existing.length + 1; i < 1000; i++) {
    const id = `${prefix}-${i}`;
    if (!existing.includes(id)) return id;
  }
  return `${prefix}-${Date.now().toString(36)}`;
}
