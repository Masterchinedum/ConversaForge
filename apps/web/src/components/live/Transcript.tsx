'use client';
import { clsx } from '@/components/ui';
import type { TranscriptRow } from '@/lib/live/store';
import { useEffect, useRef, useState } from 'react';

export function Transcript({ rows, agentName, compact }: { rows: TranscriptRow[]; agentName: string; compact?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [rows, stick]);
  const visible = rows.filter((r) => r.status !== 'partial');
  const partial = rows.find((r) => r.status === 'partial');
  return (
    <div className="relative">
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          setStick(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
        }}
        className={clsx('overflow-y-auto rounded-lg border border-slate-200 bg-white p-3', compact ? 'h-48' : 'h-64 sm:h-80')}
        tabIndex={0}
        aria-label="Conversation transcript"
      >
        {visible.length === 0 && !partial ? (
          <p className="py-6 text-center text-sm text-slate-500">Captions will appear here.</p>
        ) : (
          <ol role="log" aria-live="polite" aria-relevant="additions" className="space-y-2" data-testid="transcript">
            {visible.map((r) => (
              <li
                key={r.key}
                data-speaker={r.speaker}
                data-status={r.status}
                className={clsx('flex', r.speaker === 'PARTICIPANT' ? 'justify-end' : r.speaker === 'SYSTEM' ? 'justify-center' : 'justify-start')}
              >
                {r.speaker === 'SYSTEM' ? (
                  <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-600">{r.text}</span>
                ) : (
                  <div
                    className={clsx(
                      'max-w-[85%] rounded-2xl px-3 py-2 text-sm leading-relaxed',
                      r.speaker === 'PARTICIPANT' ? 'rounded-br-sm bg-brand-600 text-white' : 'rounded-bl-sm bg-slate-100 text-slate-900',
                      r.status === 'sending' && 'opacity-80',
                    )}
                  >
                    <span className="sr-only">{r.speaker === 'PARTICIPANT' ? 'You' : agentName}: </span>
                    {r.text}
                    {r.interrupted && <span className="ml-1 text-xs italic opacity-80">(interrupted)</span>}
                    {r.status === 'sending' && <span className="ml-1 text-xs opacity-80" aria-hidden>· sending</span>}
                  </div>
                )}
              </li>
            ))}
          </ol>
        )}
        {partial && (
          <div className="mt-2 flex justify-end" aria-hidden data-testid="partial">
            <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-dashed border-slate-300 px-3 py-2 text-sm italic text-slate-500">
              {partial.text}…
            </div>
          </div>
        )}
      </div>
      {!stick && (
        <button
          className="absolute bottom-2 right-3 rounded-full bg-slate-800 px-3 py-1 text-xs text-white shadow focus-visible:ring-2 focus-visible:ring-brand-500"
          onClick={() => setStick(true)}
        >
          ↓ Latest
        </button>
      )}
    </div>
  );
}
