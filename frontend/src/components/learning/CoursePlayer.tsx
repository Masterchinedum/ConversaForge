'use client';
/**
 * Course player used by /w/[id]/learn/courses/[courseId] (members) and /c/[token] (share link).
 * Progress is always what the API reports for the enrollment's current generation — a new enrollment
 * shows 0%. "Play All" keeps `?playAll=1` in the URL: after each practice session the live page returns
 * here and the next incomplete item starts automatically.
 */
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import { ProgressBar } from '@/components/analytics/charts';
import { Alert, Badge, Button, Card, ConfirmButton, ErrorState, Loading, Modal, SimulatedBadge, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import {
  KIND_LABEL,
  hasStoredToken,
  liveHref,
  ruleLabel,
  sameOriginMediaUrl,
  type ItemContent,
  type PlayerDetail,
  type PlayerItem,
  type StartResult,
} from '@/lib/learning';
import { formatDate } from '@/lib/format';

const STATUS_BADGE: Record<PlayerItem['status'], { tone: 'gray' | 'green' | 'yellow' | 'red' | 'blue'; label: string }> = {
  NOT_STARTED: { tone: 'gray', label: 'Not started' },
  IN_PROGRESS: { tone: 'blue', label: 'In progress' },
  COMPLETED: { tone: 'green', label: 'Completed' },
  FAILED: { tone: 'red', label: 'Not passed' },
};

export function CoursePlayer({
  apiBase,
  detailPath,
  pagePath,
  header,
  onEnrolled,
}: {
  /** API base for actions: `/workspaces/<ws>/learn/courses/<id>` or `/c/<token>`. */
  apiBase: string;
  /** API path returning PlayerDetail. */
  detailPath: string;
  /** Web path of the page hosting the player (used as the /live return target). */
  pagePath: string;
  header?: React.ReactNode;
  onEnrolled?: () => void;
}) {
  const router = useRouter();
  const search = useSearchParams();
  const toast = useToast();
  const playAll = search.get('playAll') === '1';
  const waitingForScore = useRef(false);
  const { data, error, mutate, isLoading } = useSWR<PlayerDetail>(detailPath, {
    refreshInterval: () => (waitingForScore.current ? 3000 : 0),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [viewer, setViewer] = useState<{ item: PlayerItem; content: ItemContent } | null>(null);
  const [paused, setPaused] = useState<string | null>(null);
  const autoKey = useRef<string | null>(null);

  const returnPath = (withPlayAll: boolean) => (withPlayAll ? `${pagePath}?playAll=1` : pagePath);
  const stopPlayAll = useCallback(() => router.replace(pagePath), [router, pagePath]);

  const openContent = useCallback(
    async (item: PlayerItem, content?: ItemContent | null, auto = false) => {
      const c = content ?? (await api<ItemContent>(`${apiBase}/items/${item.id}/content`));
      if (!c) return;
      // Only open a new tab on a real click (automatic Play All steps would be popup-blocked).
      if (item.kind === 'LINK' && !auto) window.open(c.url, '_blank', 'noopener,noreferrer');
      setViewer({ item, content: c });
    },
    [apiBase],
  );

  const runItem = useCallback(
    async (item: PlayerItem, opts: { playAll?: boolean } = {}) => {
      setBusy(item.id);
      try {
        const r = await api<StartResult>(`${apiBase}/items/${item.id}/start`, { method: 'POST' });
        if (r.kind === 'SCENARIO') {
          window.location.assign(liveHref(r.sessionId, r.sessionToken, returnPath(!!opts.playAll)));
          return;
        }
        await mutate();
        await openContent(item, r.content, !!opts.playAll);
      } catch (e) {
        toast.error(errorMessage(e));
        if (opts.playAll) setPaused(errorMessage(e));
      } finally {
        setBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [apiBase, mutate, openContent, toast],
  );

  const markViewed = async (item: PlayerItem) => {
    setBusy(item.id);
    try {
      const d = await api<PlayerDetail>(`${apiBase}/items/${item.id}/complete`, { method: 'POST' });
      await mutate(d, { revalidate: false });
      setViewer(null);
      toast.success(d.progress.complete ? 'Course complete — well done!' : 'Marked as viewed');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const enroll = async () => {
    setBusy('enroll');
    try {
      const d = await api<PlayerDetail>(`${apiBase}/enroll`, { method: 'POST' });
      await mutate(d, { revalidate: false });
      onEnrolled?.();
      toast.success('Enrolled');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  // Play All: advance automatically whenever the course data settles.
  useEffect(() => {
    if (!playAll || !data || busy || viewer) return;
    waitingForScore.current = false;
    if (!data.enrollment) {
      if (data.canEnroll) void enroll();
      return;
    }
    if (data.progress.complete || !data.nextItemId) {
      toast.success('Course complete — Play All finished');
      stopPlayAll();
      return;
    }
    const next = data.items.find((i) => i.id === data.nextItemId);
    if (!next) return;
    const last = next.lastAttempt;
    if (last && last.status === 'STARTED' && last.reason && /scoring/i.test(last.reason)) {
      waitingForScore.current = true; // poll until the score arrives
      return;
    }
    if (last && last.status !== 'COMPLETED' && next.kind === 'SCENARIO') {
      // Don't loop on an item the learner just failed or left mid-session — let them decide.
      setPaused(
        last.status === 'FAILED'
          ? `“${next.title}” was not completed: ${last.reason ?? 'try again when you are ready.'}`
          : `“${next.title}” is still in progress.`,
      );
      return;
    }
    const key = `${next.id}:${next.attemptCount}:${data.enrollment.generation}`;
    if (autoKey.current === key) return;
    autoKey.current = key;
    void runItem(next, { playAll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playAll, data, busy, viewer]);

  if (isLoading && !data) return <Loading />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return null;

  const { course, enrollment, progress, items } = data;
  const next = items.find((i) => i.id === data.nextItemId) ?? null;
  const anyWaiting = items.some((i) => i.lastAttempt?.status === 'STARTED' && i.lastAttempt.reason && /scoring/i.test(i.lastAttempt.reason));
  waitingForScore.current = waitingForScore.current || anyWaiting;

  return (
    <div className="space-y-6">
      {header}
      <Card>
        <div className="flex flex-col gap-4 md:flex-row">
          {course.coverImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={course.coverImageUrl} alt="" className="h-32 w-full rounded-md object-cover md:w-56" />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-slate-900">{course.title}</h1>
              {data.preview && <Badge tone="yellow">Preview — {course.status.toLowerCase()}</Badge>}
              {course.forcedOrder && <Badge>In order</Badge>}
            </div>
            {course.description && <p className="mt-1 whitespace-pre-line text-sm text-slate-600">{course.description}</p>}
            {enrollment ? (
              <div className="mt-4 max-w-md">
                <div className="mb-1 flex items-center justify-between text-sm">
                  <span className="font-medium text-slate-800">{progress.percent}% complete</span>
                  <span className="text-slate-500">
                    {progress.completedRequired} of {progress.totalRequired} required items
                  </span>
                </div>
                <ProgressBar percent={progress.percent} label={`${course.title} progress`} />
                {enrollment.status === 'COMPLETED' && enrollment.completedAt && (
                  <p className="mt-2 text-sm text-emerald-700">Completed on {formatDate(enrollment.completedAt)}</p>
                )}
                {enrollment.generation > 1 && <p className="mt-1 text-xs text-slate-500">Attempt #{enrollment.generation} (started over)</p>}
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">You are not enrolled in this course yet.</p>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              {!enrollment && data.canEnroll && (
                <Button onClick={enroll} loading={busy === 'enroll'}>
                  Enroll
                </Button>
              )}
              {enrollment && !progress.complete && next && (
                <>
                  <Button onClick={() => runItem(next)} loading={busy === next.id} disabled={!!busy}>
                    {progress.percent === 0 && !items.some((i) => i.attemptCount) ? 'Start' : 'Continue'}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={!!busy}
                    onClick={() => {
                      setPaused(null);
                      autoKey.current = null;
                      router.replace(`${pagePath}?playAll=1`);
                    }}
                  >
                    Play all
                  </Button>
                </>
              )}
              {enrollment && (progress.percent > 0 || items.some((i) => i.attemptCount > 0)) && (
                <ConfirmButton
                  variant="ghost"
                  confirmText="Start the course over? Your progress resets to 0% (past attempts stay in your history)."
                  onConfirm={async () => {
                    try {
                      const d = await api<PlayerDetail>(`${apiBase}/start-over`, { method: 'POST' });
                      await mutate(d, { revalidate: false });
                      toast.success('Started over');
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Start over
                </ConfirmButton>
              )}
              {data.canUnenroll && (
                <ConfirmButton
                  variant="ghost"
                  confirmText="Leave this course?"
                  onConfirm={async () => {
                    try {
                      await api(`${apiBase}/enroll`, { method: 'DELETE' });
                      await mutate();
                    } catch (e) {
                      toast.error(errorMessage(e));
                    }
                  }}
                >
                  Leave course
                </ConfirmButton>
              )}
            </div>
          </div>
        </div>
      </Card>

      {playAll && (
        <Alert tone={paused ? 'warning' : 'info'} title={paused ? 'Play All paused' : 'Play All is on'}>
          <div className="flex flex-wrap items-center gap-3">
            <span>{paused ?? (anyWaiting ? 'Waiting for your score before moving on…' : 'Items will start one after another.')}</span>
            {paused && next && (
              <Button
                size="sm"
                onClick={() => {
                  setPaused(null);
                  void runItem(next, { playAll: true });
                }}
              >
                Try “{next.title}” again
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={stopPlayAll}>
              Stop Play All
            </Button>
          </div>
        </Alert>
      )}

      <ol className="space-y-3" aria-label="Course items">
        {items.map((item, idx) => {
          const st = STATUS_BADGE[item.status];
          const isNext = item.id === data.nextItemId;
          const last = item.lastAttempt;
          const resumable = last?.status === 'STARTED' && last.sessionId && !last.reason && hasStoredToken(last.sessionId);
          return (
            <li key={item.id}>
              <div
                className={`rounded-lg border bg-white p-4 shadow-sm ${isNext && enrollment ? 'border-brand-500 ring-1 ring-brand-500' : 'border-slate-200'} ${item.locked ? 'opacity-70' : ''}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-xs font-medium uppercase tracking-wide text-slate-500">
                      {idx + 1}. {KIND_LABEL[item.kind]} {item.required ? '' : '· optional'} {item.locked && '· 🔒 locked'}
                    </p>
                    <h3 className="mt-0.5 font-medium text-slate-900">{item.title}</h3>
                    {item.description && <p className="mt-1 text-sm text-slate-600">{item.description}</p>}
                    {item.kind === 'SCENARIO' && item.scenario?.publicDescription && !item.description && (
                      <p className="mt-1 text-sm text-slate-600">{item.scenario.publicDescription}</p>
                    )}
                    <p className="mt-1 text-xs text-slate-500">To complete: {ruleLabel(item.completionRule)}</p>
                    {last?.reason && item.status !== 'COMPLETED' && (
                      <p className="mt-1 text-sm text-amber-700" role="status">
                        {last.reason}
                      </p>
                    )}
                    {last?.score != null && <p className="mt-1 text-xs text-slate-600">Last score: {Math.round(last.score)}</p>}
                  </div>
                  <div className="ml-auto flex flex-col items-end gap-2">
                    <Badge tone={st.tone}>{st.label}</Badge>
                    {enrollment && !item.locked && (
                      <div className="flex flex-wrap justify-end gap-2">
                        {item.kind === 'SCENARIO' ? (
                          <>
                            {resumable && (
                              <Button size="sm" variant="secondary" onClick={() => router.push(`/live/${last!.sessionId}?return=${encodeURIComponent(pagePath)}`)}>
                                Resume
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant={item.status === 'COMPLETED' ? 'secondary' : 'primary'}
                              loading={busy === item.id}
                              disabled={!!busy || item.scenario?.runnable === false}
                              onClick={() => runItem(item)}
                            >
                              {item.status === 'NOT_STARTED' ? 'Start' : item.status === 'COMPLETED' ? 'Practice again' : 'Try again'}
                            </Button>
                          </>
                        ) : (
                          <>
                            <Button size="sm" variant="secondary" loading={busy === item.id} disabled={!!busy} onClick={() => runItem(item)}>
                              {item.kind === 'LINK' ? 'Open link ↗' : item.kind === 'VIDEO' ? 'Watch' : 'Open'}
                            </Button>
                            {item.completionRule.type === 'viewed' && item.status !== 'COMPLETED' && (
                              <Button size="sm" disabled={!!busy} onClick={() => markViewed(item)}>
                                Mark as viewed
                              </Button>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {last?.sessionId && item.kind === 'SCENARIO' && (last.status === 'COMPLETED' || last.status === 'FAILED') && (
                      <Link href={`/report/${last.sessionId}`} className="text-xs text-brand-700 hover:underline">
                        View feedback
                      </Link>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      {data.history.length > 0 && (
        <Card title="Earlier attempts">
          <ul className="text-sm text-slate-600">
            {data.history.map((h) => (
              <li key={h.generation}>
                Attempt #{h.generation}: {h.completedItems} item(s) completed, {h.attempts} activity record(s) — kept for your history, not counted now.
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Modal
        open={!!viewer}
        onClose={() => {
          if (playAll && viewer && viewer.item.status !== 'COMPLETED' && viewer.item.completionRule.type === 'viewed') {
            setPaused(`Mark “${viewer.item.title}” as viewed to continue.`);
          }
          setViewer(null);
        }}
        wide
        title={viewer?.item.title ?? ''}
        footer={
          viewer && (
            <>
              <Button
                variant="secondary"
                onClick={() => {
                  if (playAll && viewer.item.status !== 'COMPLETED' && viewer.item.completionRule.type === 'viewed') {
                    setPaused(`Mark “${viewer.item.title}” as viewed to continue.`);
                  }
                  setViewer(null);
                }}
              >
                Close
              </Button>
              {viewer.item.completionRule.type === 'viewed' && viewer.item.status !== 'COMPLETED' && (
                <Button onClick={() => markViewed(viewer.item)} loading={busy === viewer.item.id}>
                  Mark as viewed{playAll ? ' & continue' : ''}
                </Button>
              )}
            </>
          )
        }
      >
        {viewer && <ContentView item={viewer.item} content={viewer.content} />}
      </Modal>
      {items.some((i) => i.kind === 'SCENARIO') && (
        <p className="text-xs text-slate-500">
          Practice sessions may run on the local simulator when no AI provider is configured; such sessions are labeled <SimulatedBadge />.
        </p>
      )}
    </div>
  );
}

function ContentView({ item, content }: { item: PlayerItem; content: ItemContent }) {
  const url = content.external ? content.url : sameOriginMediaUrl(content.url);
  if (item.kind === 'VIDEO') {
    const yt = /(?:youtube\.com\/watch\?v=|youtu\.be\/)([\w-]{6,20})/.exec(content.url);
    const vimeo = /vimeo\.com\/(\d{4,12})/.exec(content.url);
    if (content.external && (yt || vimeo)) {
      const src = yt ? `https://www.youtube-nocookie.com/embed/${yt[1]}` : `https://player.vimeo.com/video/${vimeo![1]}`;
      return <iframe src={src} title={item.title} className="aspect-video w-full rounded" allow="encrypted-media; picture-in-picture" allowFullScreen />;
    }
    return (
      <video src={url} controls className="w-full rounded bg-black" preload="metadata">
        Your browser cannot play this video. <a href={url}>Download it</a>.
      </video>
    );
  }
  if (item.kind === 'DOCUMENT') {
    return (
      <div className="space-y-2">
        {!content.external && <iframe src={url} title={item.title} className="h-[60vh] w-full rounded border border-slate-200" />}
        <a href={url} target="_blank" rel="noopener noreferrer" className="text-sm text-brand-700 hover:underline">
          Open {content.fileName ?? 'document'} in a new tab ↗
        </a>
      </div>
    );
  }
  return (
    <div className="space-y-2 text-sm">
      <p>Open the link (new tab). When you are done, mark it as viewed.</p>
      <a href={content.url} target="_blank" rel="noopener noreferrer" className="break-all text-brand-700 hover:underline">
        {content.url} ↗
      </a>
    </div>
  );
}
