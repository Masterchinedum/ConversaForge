'use client';
/**
 * Course share link. Anyone can see the course outline; signing in lets the user enroll and take the
 * course here (non-members) or in their workspace (members).
 */
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { Suspense, useState } from 'react';
import useSWR from 'swr';
import { CoursePlayer } from '@/components/learning/CoursePlayer';
import { Button, ButtonLink, Card, ErrorState, Loading, useToast } from '@/components/ui';
import { api, ApiError, errorMessage } from '@/lib/api';
import { KIND_LABEL, type ItemKind } from '@/lib/learning';

interface CourseLinkInfo {
  course: {
    id: string;
    workspaceId: string;
    title: string;
    description: string | null;
    coverImageUrl: string | null;
    forcedOrder: boolean;
    items: Array<{ id: string; title: string; kind: ItemKind; required: boolean }>;
  };
  organization: { name: string; primaryColor: string | null; logoUrl: string | null };
  viewer: { signedIn: boolean; isMember: boolean; enrolled: boolean };
}

function CourseLink() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<CourseLinkInfo>(`/c/${encodeURIComponent(token)}`);
  const [busy, setBusy] = useState(false);
  const pagePath = `/c/${token}`;

  if (isLoading) return <Loading />;
  if (error) {
    if (error instanceof ApiError && error.status === 404)
      return (
        <Card>
          <h1 className="text-lg font-semibold">This course link is not available</h1>
          <p className="mt-1 text-sm text-slate-600">It may have been revoked or replaced, or the course is no longer published. Ask the person who shared it for a new link.</p>
        </Card>
      );
    return <ErrorState error={error} retry={() => mutate()} />;
  }
  if (!data) return null;
  const { course, organization, viewer } = data;

  const openInWorkspace = async () => {
    setBusy(true);
    try {
      await api(`/c/${encodeURIComponent(token)}/enroll`, { method: 'POST' });
      router.push(`/w/${course.workspaceId}/learn/courses/${course.id}`);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  const orgHeader = (
    <p className="text-xs font-medium uppercase tracking-wide text-slate-500" style={organization.primaryColor ? { color: organization.primaryColor } : undefined}>
      {organization.name}
    </p>
  );

  if (viewer.signedIn && !viewer.isMember) {
    return <CoursePlayer apiBase={`/c/${encodeURIComponent(token)}`} detailPath={`/c/${encodeURIComponent(token)}/player`} pagePath={pagePath} header={orgHeader} onEnrolled={() => mutate()} />;
  }

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex flex-col gap-4 md:flex-row">
          {course.coverImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={course.coverImageUrl} alt="" className="h-36 w-full rounded-md object-cover md:w-64" />
          )}
          <div className="min-w-0 flex-1">
            {orgHeader}
            <h1 className="mt-1 text-2xl font-semibold text-slate-900">{course.title}</h1>
            {course.description && <p className="mt-2 whitespace-pre-line text-sm text-slate-600">{course.description}</p>}
            <div className="mt-4 flex flex-wrap gap-2">
              {viewer.signedIn ? (
                <Button onClick={openInWorkspace} loading={busy}>
                  {viewer.enrolled ? 'Continue in your workspace' : 'Enroll & start'}
                </Button>
              ) : (
                <>
                  <ButtonLink href={`/login?next=${encodeURIComponent(pagePath)}`}>Sign in to start</ButtonLink>
                  <ButtonLink href={`/signup?next=${encodeURIComponent(pagePath)}`} variant="secondary">
                    Create an account
                  </ButtonLink>
                </>
              )}
            </div>
          </div>
        </div>
      </Card>
      <Card title={`What's inside (${course.items.length})`}>
        <ol className="space-y-2 text-sm">
          {course.items.map((i, idx) => (
            <li key={i.id} className="flex items-center justify-between gap-2">
              <span>
                {idx + 1}. {i.title}
                {!i.required && <span className="text-xs text-slate-500"> (optional)</span>}
              </span>
              <span className="text-xs text-slate-500">{KIND_LABEL[i.kind]}</span>
            </li>
          ))}
        </ol>
        {course.forcedOrder && <p className="mt-3 text-xs text-slate-500">Items are taken in order.</p>}
      </Card>
    </div>
  );
}

export default function CourseLinkPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <div className="mb-6">
        <Link href="/" className="text-lg font-bold text-brand-700">
          ConversaForge
        </Link>
      </div>
      <Suspense fallback={<Loading />}>
        <CourseLink />
      </Suspense>
    </main>
  );
}
