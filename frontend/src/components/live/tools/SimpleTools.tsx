'use client';
import { Button, clsx, Textarea } from '@/components/ui';
import type { PresentedTool } from '@cf/shared';
import { useEffect, useId, useRef, useState } from 'react';
import { formatClock } from '../branding';

export interface ToolProps {
  tool: PresentedTool;
  respond: (result: Record<string, unknown>) => void;
  update: (data: Record<string, unknown>) => void;
  sessionId: string;
  token: string;
}

const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

export function CardTool({ tool }: ToolProps) {
  const title = str(tool.args.title, tool.title);
  const body = str(tool.args.body);
  return (
    <div className="space-y-2">
      {title && <h3 className="text-base font-semibold text-slate-900">{title}</h3>}
      {body && <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{body}</p>}
    </div>
  );
}

export function NotepadTool({ tool, update }: ToolProps) {
  const remote = str(tool.data?.content);
  const [value, setValue] = useState(remote);
  const typingUntil = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();
  // Accept remote changes when the participant is not actively typing.
  useEffect(() => {
    if (Date.now() > typingUntil.current && remote !== value) setValue(remote);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remote]);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const onChange = (v: string) => {
    const clipped = v.slice(0, 15000);
    setValue(clipped);
    typingUntil.current = Date.now() + 1500;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => update({ content: clipped }), 600);
  };
  const prompt = str(tool.args.prompt);
  return (
    <div className="space-y-2">
      {prompt && <p className="text-sm text-slate-700">{prompt}</p>}
      <label htmlFor={id} className="sr-only">
        Notepad
      </label>
      <Textarea
        id={id}
        rows={10}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono text-[13px]"
        placeholder="Type here — the agent can read this notepad."
        onKeyDown={(e) => e.stopPropagation()}
      />
      <p className="text-xs text-slate-500">{value.length.toLocaleString()} / 15,000 · saved automatically</p>
    </div>
  );
}

export function MultipleChoiceTool({ tool, respond }: ToolProps) {
  const question = str(tool.args.question);
  const options = Array.isArray(tool.args.options) ? (tool.args.options as unknown[]).map((o) => String(o)) : [];
  const multi = tool.args.allowMultiple === true;
  const submittedRemote = tool.data?.answered === true || tool.data?.submitted === true || Array.isArray(tool.data?.selected);
  const [selected, setSelected] = useState<number[]>(Array.isArray(tool.data?.selected) ? (tool.data!.selected as number[]) : []);
  const [submitted, setSubmitted] = useState(submittedRemote);
  const name = useId();
  const toggle = (i: number) => setSelected((s) => (multi ? (s.includes(i) ? s.filter((x) => x !== i) : [...s, i].sort()) : [i]));
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!selected.length || submitted) return;
        setSubmitted(true);
        respond({ selected, answers: selected.map((i) => options[i]) });
      }}
    >
      <fieldset disabled={submitted} className="space-y-2">
        <legend className="mb-2 text-sm font-medium text-slate-900">{question}</legend>
        {options.map((opt, i) => (
          <label
            key={i}
            className={clsx(
              'flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm focus-within:ring-2 focus-within:ring-brand-500',
              selected.includes(i) ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50',
            )}
          >
            <input
              type={multi ? 'checkbox' : 'radio'}
              name={name}
              className="mt-0.5"
              checked={selected.includes(i)}
              onChange={() => toggle(i)}
            />
            <span>{opt}</span>
          </label>
        ))}
      </fieldset>
      {submitted ? (
        <p className="text-sm font-medium text-emerald-700" role="status">
          ✓ Answer submitted
        </p>
      ) : (
        <Button type="submit" disabled={!selected.length}>
          Submit answer
        </Button>
      )}
    </form>
  );
}

export function TimerTool({ tool }: ToolProps) {
  const seconds = Math.max(5, Math.min(3600, Number(tool.args.seconds) || 60));
  const label = str(tool.args.label);
  const startedAt = useRef<number>(
    typeof tool.data?.startedAt === 'string' ? Date.parse(tool.data.startedAt as string) || Date.now() : typeof tool.data?.startedAt === 'number' ? (tool.data.startedAt as number) : Date.now(),
  );
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, []);
  const remaining = Math.max(0, seconds * 1000 - (now - startedAt.current));
  const done = remaining <= 0;
  const pct = Math.round((remaining / (seconds * 1000)) * 100);
  // Announce only at meaningful points (each minute, last 10 s, done).
  const announce = done ? 'Time is up' : remaining <= 10000 ? `${Math.ceil(remaining / 1000)} seconds left` : `${Math.ceil(remaining / 60000)} minutes left`;
  return (
    <div className="space-y-2 text-center">
      {label && <p className="text-sm text-slate-700">{label}</p>}
      <p className={clsx('font-mono text-4xl font-semibold tabular-nums', done ? 'text-red-600' : 'text-slate-900')} aria-hidden>
        {formatClock(remaining)}
      </p>
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200" aria-hidden>
        <div className={clsx('h-full', done ? 'bg-red-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
