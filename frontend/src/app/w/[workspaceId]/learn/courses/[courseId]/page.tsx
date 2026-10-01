'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { CoursePlayer } from '@/components/learning/CoursePlayer';
import { Loading } from '@/components/ui';
import { useWorkspace } from '@/lib/workspace';

function Player() {
  const { courseId } = useParams<{ courseId: string }>();
  const { wsPath, href } = useWorkspace();
  const base = wsPath(`/learn/courses/${courseId}`);
  return (
    <CoursePlayer
      apiBase={base}
      detailPath={base}
      pagePath={href(`/learn/courses/${courseId}`)}
      header={
        <Link href={href('/learn')} className="text-xs text-slate-500 hover:text-slate-800">
          ← My learning
        </Link>
      }
    />
  );
}

export default function CoursePlayerPage() {
  return (
    <Suspense fallback={<Loading />}>
      <Player />
    </Suspense>
  );
}
