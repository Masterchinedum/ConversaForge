'use client';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import useSWR from 'swr';
import { can } from '@cf/shared';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/workspace';
import { Alert, Badge, Button, ButtonLink, Card, EmptyState, ErrorState, Loading, Select } from '@/components/ui';
import type { GalleryCardData, ScenarioDetail } from '@/components/scenarios/types';

type Detail = GalleryCardData & { participantInstructions: string; maxDurationMinutes: number };

export default function TemplatePage() {
  const { key } = useParams<{ key: string }>();
  const router = useRouter();
  const { data, error } = useSWR<Detail>(`/gallery/templates/${encodeURIComponent(key)}`);
  const { data: me } = useMe();
  const workspaces = (me?.workspaces ?? []).filter((w) => can(w.role, 'scenarios.edit'));
  const [ws, setWs] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (error instanceof ApiError && error.status === 404) return <EmptyState title="Template not found" action={<Link href="/gallery" className="text-brand-700 underline">Back to the gallery</Link>} />;
  if (error) return <ErrorState error={error} />;
  if (!data) return <Loading />;
  const target = ws || workspaces[0]?.id || '';

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Link href="/gallery" className="text-xs text-slate-500 hover:text-slate-800">
        ← Gallery
      </Link>
      <h1 className="text-2xl font-semibold">{data.name}</h1>
      <div className="flex flex-wrap gap-2 text-xs">
        <Badge tone="purple">Template</Badge>
        <Badge tone="blue">{data.typeLabel}</Badge>
        <Badge tone="gray">~{data.durationMinutes} min</Badge>
        {data.personaName && <Badge tone="gray">With {data.personaName}</Badge>}
      </div>
      <p className="text-slate-700">{data.summary ?? data.publicDescription}</p>
      <Card title="Participant instructions">
        <p className="whitespace-pre-wrap text-sm text-slate-700">{data.participantInstructions}</p>
      </Card>
      <Card title="Use this template">
        {!me ? (
          <div className="flex gap-2">
            <ButtonLink href={`/login?next=${encodeURIComponent(`/gallery/templates/${key}`)}`}>Log in</ButtonLink>
            <ButtonLink variant="secondary" href={`/signup?next=${encodeURIComponent(`/gallery/templates/${key}`)}`}>
              Sign up free
            </ButtonLink>
          </div>
        ) : !workspaces.length ? (
          <p className="text-sm text-slate-600">You need the Creator role in a workspace to build from templates.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="Workspace" className="w-64" value={target} onChange={(e) => setWs(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
            <Button
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setErr(null);
                try {
                  const d = await api<ScenarioDetail>(`/workspaces/${target}/scenarios`, { method: 'POST', body: { source: 'template', templateKey: key } });
                  router.push(`/w/${target}/scenarios/${d.scenario.id}`);
                } catch (e) {
                  setErr(errorMessage(e));
                  setBusy(false);
                }
              }}
            >
              Create scenario
            </Button>
          </div>
        )}
        {err && <Alert tone="error">{err}</Alert>}
      </Card>
    </div>
  );
}
