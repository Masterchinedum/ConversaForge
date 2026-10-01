'use client';
import Link from 'next/link';
import { SimulatedBadge, Table, Td, Th } from '@/components/ui';
import { formatDate, formatDuration } from '@/lib/format';
import type { AnalyticsSummary } from './types';

export function RecentSessions({ sessions, linkFor }: { sessions: AnalyticsSummary['recentSessions']; linkFor: (id: string) => string }) {
  if (!sessions.length) return <p className="text-sm text-slate-500">No sessions in this period.</p>;
  return (
    <Table>
      <thead>
        <tr>
          <Th>When</Th>
          <Th>Scenario</Th>
          <Th>Learner</Th>
          <Th>State</Th>
          <Th className="text-right">Duration</Th>
          <Th className="text-right">Score</Th>
        </tr>
      </thead>
      <tbody className="divide-y divide-slate-100">
        {sessions.map((s) => (
          <tr key={s.id}>
            <Td className="text-xs">
              <Link href={linkFor(s.id)} className="text-brand-700 hover:underline">
                {formatDate(s.createdAt)}
              </Link>
            </Td>
            <Td className="whitespace-normal">
              {s.scenario.name ?? '—'} {s.simulated && <SimulatedBadge />}
            </Td>
            <Td>{s.participant.name}</Td>
            <Td className="text-xs">{s.state.toLowerCase()}</Td>
            <Td className="text-right text-xs tabular-nums">{formatDuration(s.durationMs)}</Td>
            <Td className="text-right tabular-nums">{s.insufficientEvidence ? <span className="text-xs text-slate-500">insufficient evidence</span> : s.overallScore ?? '—'}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}
