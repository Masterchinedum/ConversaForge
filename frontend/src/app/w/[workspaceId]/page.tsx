'use client';
/**
 * Workspace dashboard (role-aware).
 *  - creators / reviewers / admins: 30-day KPIs, sessions trend, recent sessions, shortcuts
 *  - learners: their courses with honest progress, next steps and their recent sessions
 */
import Link from 'next/link';
import useSWR from 'swr';
import { LineChart, ProgressBar } from '@/components/analytics/charts';
import { RecentSessions } from '@/components/analytics/RecentSessions';
import { formatHours, type AnalyticsSummary } from '@/components/analytics/types';
import { Alert, ButtonLink, Card, EmptyState, ErrorState, Loading, PageHeader, Stat } from '@/components/ui';
import type { CourseSummary, EnrollmentInfo, Progress } from '@/lib/learning';
import { useWorkspace } from '@/lib/workspace';

interface LearnOverview {
  enrollments: Array<{ enrollment: EnrollmentInfo; course: CourseSummary; progress: Progress; nextItem: { id: string; title: string; kind: string } | null }>;
  available: Array<CourseSummary & { itemCount: number }>;
}

const last30 = () => ({
  from: new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10),
  to: new Date().toISOString().slice(0, 10),
});

export default function DashboardPage() {
  const { workspace, can, me } = useWorkspace();
  const reviewer = can('analytics.view');
  return (
    <div className="space-y-8">
      <PageHeader title={workspace.name} description={`Welcome back${me.user.name ? `, ${me.user.name.split(' ')[0]}` : ''}.`} />
      {reviewer ? <TeamOverview /> : <LearnerOverview />}
    </div>
  );
}

function TeamOverview() {
  const { wsPath, href, can } = useWorkspace();
  const range = last30();
  const { data, error, isLoading, mutate } = useSWR<AnalyticsSummary>([wsPath('/analytics/summary'), range]);
  return (
    <>
      <section className="space-y-4" aria-labelledby="kpis">
        <div className="flex items-center justify-between">
          <h2 id="kpis" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            Last 30 days
          </h2>
          <Link href={href('/analytics')} className="text-sm text-brand-700 hover:underline">
            Full analytics →
          </Link>
        </div>
        {isLoading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} retry={() => mutate()} />
        ) : data ? (
          <>
            {data.kpis.simulatedSessions > 0 && (
              <Alert tone="warning">
                {data.kpis.simulatedShare}% of sessions ran on the local simulator (no AI provider configured).{' '}
                {can('providers.manage') && (
                  <Link href={href('/settings/providers')} className="underline">
                    Configure a provider
                  </Link>
                )}
              </Alert>
            )}
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Sessions" value={data.kpis.sessions} hint={`${data.kpis.learners} learner(s)`} />
              <Stat label="Completion rate" value={data.kpis.completionRate == null ? '—' : `${data.kpis.completionRate}%`} />
              <Stat
                label="Avg score"
                value={data.kpis.avgScore ?? '—'}
                hint={data.kpis.insufficientEvidence ? `${data.kpis.insufficientEvidence} with insufficient evidence` : `${data.kpis.scoredSessions} scored`}
              />
              <Stat label="Practice time" value={formatHours(data.kpis.totalDurationMs)} />
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card title="Sessions per day">
                <LineChart label="Sessions" points={data.daily.map((d) => ({ x: d.date, y: d.sessions, note: `${d.completed} completed` }))} height={150} />
              </Card>
              <Card title="Average score per day">
                <LineChart label="Avg score" yMax={100} height={150} points={data.daily.map((d) => ({ x: d.date, y: d.avgScore }))} empty="No scored sessions yet" />
              </Card>
            </div>
            <Card title="Recent sessions">
              <RecentSessions sessions={data.recentSessions} linkFor={(id) => (can('sessions.review') ? href(`/sessions/${id}`) : `/report/${id}`)} />
            </Card>
          </>
        ) : null}
      </section>
      <section className="grid gap-4 md:grid-cols-3" aria-label="Shortcuts">
        {can('scenarios.edit') && (
          <Card title="Scenarios">
            <p className="mb-3 text-sm text-slate-600">Configure AI agents for interviews, coaching, sales practice and more.</p>
            <ButtonLink href={href('/scenarios')} size="sm">
              Open scenarios
            </ButtonLink>
          </Card>
        )}
        {can('courses.edit') && (
          <Card title="Courses">
            <p className="mb-3 text-sm text-slate-600">Sequence practice and content; assign to members and teams.</p>
            <ButtonLink href={href('/courses')} size="sm" variant="secondary">
              Open courses
            </ButtonLink>
          </Card>
        )}
        {can('sessions.review') && (
          <Card title="Review sessions">
            <p className="mb-3 text-sm text-slate-600">Transcripts, recordings, scores and extracted data.</p>
            <ButtonLink href={href('/sessions')} size="sm" variant="secondary">
              Open sessions
            </ButtonLink>
          </Card>
        )}
      </section>
    </>
  );
}

function LearnerOverview() {
  const { wsPath, href } = useWorkspace();
  const learn = useSWR<LearnOverview>(wsPath('/learn'));
  const stats = useSWR<AnalyticsSummary>([wsPath('/analytics/summary'), last30()]);
  const active = learn.data?.enrollments.filter((e) => e.enrollment.status !== 'COMPLETED') ?? [];
  const nextUp = active.find((e) => e.nextItem);

  return (
    <>
      {nextUp && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Next step</p>
              <p className="font-medium text-slate-900">
                {nextUp.nextItem!.title} <span className="font-normal text-slate-500">in {nextUp.course.title}</span>
              </p>
            </div>
            <ButtonLink href={href(`/learn/courses/${nextUp.course.id}`)}>{nextUp.progress.percent === 0 && !nextUp.enrollment.startedAt ? 'Start' : 'Continue'}</ButtonLink>
          </div>
        </Card>
      )}
      <section aria-labelledby="courses-h" className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 id="courses-h" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            My courses
          </h2>
          <Link href={href('/learn')} className="text-sm text-brand-700 hover:underline">
            My learning →
          </Link>
        </div>
        {learn.isLoading ? (
          <Loading />
        ) : learn.error ? (
          <ErrorState error={learn.error} retry={() => learn.mutate()} />
        ) : !learn.data?.enrollments.length ? (
          <EmptyState
            title="No courses yet"
            description={learn.data?.available.length ? `${learn.data.available.length} course(s) are open for you to enroll.` : 'Courses assigned to you will appear here.'}
            action={
              learn.data?.available.length ? (
                <ButtonLink href={href('/learn')} size="sm">
                  Browse courses
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {learn.data.enrollments.slice(0, 6).map(({ enrollment, course, progress, nextItem }) => (
              <Link key={enrollment.id} href={href(`/learn/courses/${course.id}`)} className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-brand-500">
                <div className="flex justify-between gap-2 text-sm">
                  <span className="font-medium text-slate-900">{course.title}</span>
                  <span className="tabular-nums text-slate-600">{progress.percent}%</span>
                </div>
                <ProgressBar percent={progress.percent} className="mt-2" label={`${course.title} progress`} />
                <p className="mt-2 truncate text-xs text-slate-500">
                  {enrollment.status === 'COMPLETED' ? 'Completed' : nextItem ? `Next: ${nextItem.title}` : `${progress.completedRequired}/${progress.totalRequired} required items`}
                </p>
              </Link>
            ))}
          </div>
        )}
      </section>
      <section aria-labelledby="mine-h" className="space-y-3">
        <h2 id="mine-h" className="text-sm font-semibold uppercase tracking-wide text-slate-500">
          My practice (last 30 days)
        </h2>
        {stats.data ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <Stat label="Sessions" value={stats.data.kpis.sessions} />
              <Stat label="Completed" value={stats.data.kpis.completed} />
              <Stat label="Practice time" value={formatHours(stats.data.kpis.totalDurationMs)} />
              <Stat label="Avg score" value={stats.data.kpis.avgScore ?? '—'} hint={stats.data.kpis.scoredSessions ? `${stats.data.kpis.scoredSessions} scored` : 'scores appear when shared with you'} />
            </div>
            <Card title="My recent sessions">
              <RecentSessions sessions={stats.data.recentSessions} linkFor={(id) => `/report/${id}`} />
            </Card>
          </>
        ) : stats.error ? (
          <ErrorState error={stats.error} retry={() => stats.mutate()} />
        ) : (
          <Loading />
        )}
      </section>
    </>
  );
}
