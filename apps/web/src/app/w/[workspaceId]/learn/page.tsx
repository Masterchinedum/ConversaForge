'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { ProgressBar } from '@/components/analytics/charts';
import { Badge, Button, ButtonLink, Card, ConfirmButton, EmptyState, ErrorState, Loading, PageHeader, SimulatedBadge, useToast } from '@/components/ui';
import { api, ApiError, errorMessage, fetcher } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/format';
import { liveHref, type CourseSummary, type EnrollmentInfo, type Progress } from '@/lib/learning';
import { useWorkspace } from '@/lib/workspace';

interface Overview {
  enrollments: Array<{ enrollment: EnrollmentInfo; course: CourseSummary; progress: Progress; nextItem: { id: string; title: string; kind: string } | null }>;
  available: Array<CourseSummary & { itemCount: number }>;
  canPreviewDrafts: boolean;
}
interface SharedScenario {
  scenario: { id: string; name: string; description?: string } | null;
  workspace: { id: string; name: string };
  canRun: boolean;
  canViewResults: boolean;
  runnable: boolean;
  expiresAt: string | null;
}
interface MySession {
  id: string;
  workspace: { id: string; name: string };
  scenario: { id: string; name: string };
  state: string;
  durationMs: number | null;
  createdAt: string;
  overallScore: number | null;
  scoresVisible?: boolean;
  simulated?: boolean;
  enrollmentId: string | null;
}

/** Fetch an optional endpoint owned by another workstream; a 404 means "not available" (null), not an error. */
const optional = async (key: string | [string, Record<string, string | number>]) => {
  try {
    return await fetcher(key as any);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 404 || e.status === 501)) return null;
    throw e;
  }
};

export default function LearnPage() {
  const { wsPath, href, workspaceId } = useWorkspace();
  const router = useRouter();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<Overview>(wsPath('/learn'));
  const shared = useSWR<{ data: SharedScenario[] } | null>('/me/shared-scenarios', optional, { shouldRetryOnError: false });
  const sessions = useSWR<{ data: MySession[] } | null>(['/me/sessions', { workspaceId, limit: 10 }], optional, { shouldRetryOnError: false });
  const [busy, setBusy] = useState<string | null>(null);

  const startOver = async (courseId: string) => {
    try {
      await api(wsPath(`/learn/courses/${courseId}/start-over`), { method: 'POST' });
      await mutate();
      toast.success('Progress reset — your earlier attempts are kept in the history');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  const enroll = async (courseId: string) => {
    setBusy(courseId);
    try {
      await api(wsPath(`/learn/courses/${courseId}/enroll`), { method: 'POST' });
      router.push(href(`/learn/courses/${courseId}`));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };
  const runShared = async (s: SharedScenario) => {
    if (!s.scenario) return;
    setBusy(s.scenario.id);
    try {
      const r = await api<{ sessionId: string; sessionToken: string }>(`/shared/scenarios/${s.scenario.id}/sessions`, { method: 'POST', body: { variables: {} } });
      window.location.assign(liveHref(r.sessionId, r.sessionToken, href('/learn')));
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return null;

  const active = data.enrollments.filter((e) => e.enrollment.status !== 'COMPLETED');
  const done = data.enrollments.filter((e) => e.enrollment.status === 'COMPLETED');

  return (
    <div className="space-y-8">
      <PageHeader
        title="My learning"
        description="Your courses, scenarios shared with you and recent practice sessions."
        actions={
          <ButtonLink href={href('/learn/memory')} variant="secondary">
            My coach memory
          </ButtonLink>
        }
      />

      <section aria-labelledby="my-courses">
        <h2 id="my-courses" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          My courses
        </h2>
        {data.enrollments.length === 0 ? (
          <EmptyState title="No courses yet" description="Courses assigned to you or that you enroll in appear here." />
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {[...active, ...done].map(({ enrollment, course, progress, nextItem }) => (
              <Card key={enrollment.id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <Link href={href(`/learn/courses/${course.id}`)} className="font-medium text-slate-900 hover:underline">
                      {course.title}
                    </Link>
                    <p className="text-xs text-slate-500">
                      {enrollment.assigned ? 'Assigned to you' : 'Self-enrolled'} · {formatDate(enrollment.createdAt)}
                    </p>
                  </div>
                  {enrollment.status === 'COMPLETED' ? <Badge tone="green">Completed</Badge> : course.status === 'ARCHIVED' ? <Badge>Archived</Badge> : null}
                </div>
                <div className="mt-3">
                  <div className="mb-1 flex justify-between text-xs text-slate-600">
                    <span>{progress.percent}%</span>
                    <span>
                      {progress.completedRequired}/{progress.totalRequired} required
                    </span>
                  </div>
                  <ProgressBar percent={progress.percent} label={`${course.title} progress`} />
                </div>
                {nextItem && enrollment.status !== 'COMPLETED' && <p className="mt-2 truncate text-xs text-slate-500">Next: {nextItem.title}</p>}
                <div className="mt-3 flex flex-wrap gap-2">
                  <ButtonLink href={href(`/learn/courses/${course.id}`)} size="sm">
                    {enrollment.status === 'COMPLETED' ? 'Review' : progress.percent === 0 && !enrollment.startedAt ? 'Start' : 'Continue'}
                  </ButtonLink>
                  {enrollment.status !== 'COMPLETED' && course.status === 'PUBLISHED' && (
                    <ButtonLink href={href(`/learn/courses/${course.id}?playAll=1`)} size="sm" variant="secondary">
                      Play all
                    </ButtonLink>
                  )}
                  {(progress.percent > 0 || enrollment.startedAt) && (
                    <ConfirmButton
                      size="sm"
                      variant="ghost"
                      confirmText="Start this course over? Progress resets to 0%; earlier attempts stay in your history."
                      onConfirm={() => startOver(course.id)}
                    >
                      Start over
                    </ConfirmButton>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {data.available.length > 0 && (
        <section aria-labelledby="available">
          <h2 id="available" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
            Available courses
          </h2>
          <div className="grid gap-4 md:grid-cols-3">
            {data.available.map((c) => (
              <Card key={c.id}>
                <p className="font-medium text-slate-900">{c.title}</p>
                {c.description && <p className="mt-1 line-clamp-3 text-sm text-slate-600">{c.description}</p>}
                <p className="mt-2 text-xs text-slate-500">{c.itemCount} items</p>
                <div className="mt-3 flex gap-2">
                  <Button size="sm" onClick={() => enroll(c.id)} loading={busy === c.id}>
                    Enroll
                  </Button>
                  <ButtonLink size="sm" variant="ghost" href={href(`/learn/courses/${c.id}`)}>
                    Details
                  </ButtonLink>
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="shared">
        <h2 id="shared" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          Shared with me
        </h2>
        {shared.data === undefined && !shared.error ? (
          <Loading />
        ) : shared.error ? (
          <p className="text-sm text-slate-500">Shared scenarios could not be loaded.</p>
        ) : !shared.data || shared.data.data.length === 0 ? (
          <p className="text-sm text-slate-500">No scenarios have been shared with you.</p>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {shared.data.data.map((s) =>
              s.scenario ? (
                <Card key={`${s.workspace.id}:${s.scenario.id}`}>
                  <p className="font-medium text-slate-900">{s.scenario.name}</p>
                  <p className="text-xs text-slate-500">
                    From {s.workspace.name}
                    {s.expiresAt ? ` · access until ${formatDate(s.expiresAt)}` : ''}
                  </p>
                  {s.scenario.description && <p className="mt-1 line-clamp-2 text-sm text-slate-600">{s.scenario.description}</p>}
                  <div className="mt-3">
                    {s.canRun && s.runnable ? (
                      <Button size="sm" onClick={() => runShared(s)} loading={busy === s.scenario.id}>
                        Start practice
                      </Button>
                    ) : (
                      <Badge>{s.runnable ? 'View only' : 'Not available right now'}</Badge>
                    )}
                  </div>
                </Card>
              ) : null,
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="recent">
        <h2 id="recent" className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
          My recent sessions
        </h2>
        {sessions.data === undefined && !sessions.error ? (
          <Loading />
        ) : !sessions.data || sessions.data.data.length === 0 ? (
          <p className="text-sm text-slate-500">{sessions.error ? 'Sessions could not be loaded.' : 'No practice sessions yet.'}</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
            {sessions.data.data.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                <div className="min-w-0">
                  <p className="font-medium text-slate-900">{s.scenario.name}</p>
                  <p className="text-xs text-slate-500">
                    {formatDate(s.createdAt)} · {formatDuration(s.durationMs)} · {s.state.toLowerCase()}
                    {s.enrollmentId ? ' · course' : ''}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {s.simulated && <SimulatedBadge />}
                  {s.overallScore != null && <span className="tabular-nums text-slate-700">Score {Math.round(s.overallScore)}</span>}
                  <Link href={`/report/${s.id}`} className="text-brand-700 hover:underline">
                    Report
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
