'use client';
import { Fragment } from 'react';
import { Badge, Spinner } from '@/components/ui';
import { isProcessing, type KnowledgeStatus } from './types';

export function StatusPill({ status, error }: { status: KnowledgeStatus; error?: string | null }) {
  if (isProcessing(status)) {
    return (
      <Badge tone="blue" title={error ?? undefined}>
        <Spinner className="mr-1 h-3 w-3" />
        {status === 'QUEUED' ? 'Queued' : 'Processing'}
      </Badge>
    );
  }
  if (status === 'COMPLETED') return <Badge tone="green">Ready</Badge>;
  if (status === 'FAILED') return <Badge tone="red" title={error ?? undefined}>Failed</Badge>;
  return <Badge>{status.toLowerCase()}</Badge>;
}

/** Render a snippet whose matches are wrapped in «…» (plain text from the API; React escapes it). */
export function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(«[^»]*»)/g);
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('«') && p.endsWith('»') ? (
          <mark key={i} className="rounded bg-amber-100 px-0.5 text-slate-900">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <Fragment key={i}>{p}</Fragment>
        ),
      )}
    </>
  );
}
