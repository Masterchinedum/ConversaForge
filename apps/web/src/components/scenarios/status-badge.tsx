'use client';
import { Badge } from '@/components/ui';
import type { ScenarioRow } from './types';

export function StatusBadge({ row }: { row: Pick<ScenarioRow, 'status' | 'latestVersionNumber' | 'draftHasUnpublishedChanges'> }) {
  if (row.status === 'ARCHIVED') return <Badge tone="gray">Archived</Badge>;
  if (row.status === 'PUBLISHED')
    return (
      <span className="inline-flex gap-1">
        <Badge tone="green">Published v{row.latestVersionNumber}</Badge>
        {row.draftHasUnpublishedChanges && <Badge tone="yellow">Unpublished changes</Badge>}
      </span>
    );
  return <Badge tone="blue">Draft</Badge>;
}
