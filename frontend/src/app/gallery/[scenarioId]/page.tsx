'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { ApiError } from '@/lib/api';
import { Badge, ButtonLink, Card, EmptyState, ErrorState, Loading } from '@/components/ui';
import type { GalleryCardData } from '@/components/scenarios/types';

type Detail = GalleryCardData & {
  participantInstructions: string;
  maxDurationMinutes: number;
  language: string;
  recording: { audio: boolean; video: boolean };
  analysis: boolean;
};

export default function PublicScenarioPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const { data, error, mutate } = useSWR<Detail>(`/gallery/${encodeURIComponent(scenarioId)}`);
  if (error instanceof ApiError && error.status === 404)
    return <EmptyState title="Scenario not found" description="It may have been unpublished or made private." action={<Link href="/gallery" className="text-brand-700 underline">Back to the gallery</Link>} />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;
  const brand = data.workspace?.primaryColor ?? undefined;
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/gallery" className="text-xs text-slate-500 hover:text-slate-800">
        ← Gallery
      </Link>
      <div className="flex items-center gap-3">
        {data.workspace?.logoUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={data.workspace.logoUrl} alt="" className="h-10 w-10 rounded object-contain" />
        )}
        <div>
          <p className="text-xs text-slate-500">{data.workspace?.name}</p>
          <h1 className="text-2xl font-semibold text-slate-900" style={brand ? { color: brand } : undefined}>
            {data.name}
          </h1>
        </div>
      </div>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="blue">{data.typeLabel}</Badge>
        <Badge tone="gray">~{data.durationMinutes} min (max {data.maxDurationMinutes})</Badge>
        {data.personaName && <Badge tone="gray">With {data.personaName}</Badge>}
        {data.tags.map((t) => (
          <Badge key={t} tone="gray">
            #{t}
          </Badge>
        ))}
      </div>
      <p className="text-slate-700">{data.publicDescription}</p>
      <Card title="How it works">
        <p className="whitespace-pre-wrap text-sm text-slate-700">{data.participantInstructions}</p>
        <p className="mt-3 text-xs text-slate-500">
          You will talk with an AI agent by voice in your browser.
          {data.recording.audio || data.recording.video ? ` The session is recorded (${[data.recording.audio && 'audio', data.recording.video && 'video'].filter(Boolean).join(' and ')}).` : ''}
          {data.analysis ? ' The conversation is analyzed by AI to produce feedback.' : ''} You will be asked for consent before starting.
        </p>
      </Card>
      <ButtonLink href={data.runUrl ?? `/p/${data.id}`} size="lg">
        Start
      </ButtonLink>
    </div>
  );
}
