'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Badge, Button, Card, Checkbox, ErrorState, Field, Input, Loading, PageHeader, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDay } from '@/lib/format';
import { useMe, useWorkspace } from '@/lib/workspace';

interface WorkspaceSettings {
  maxSessionMinutes?: number;
  defaultRetentionDays?: number;
  allowPublicScenarios?: boolean;
  allowSimulator?: boolean;
  analyticsVisibleToMembers?: boolean;
}
interface WorkspaceDto {
  id: string;
  name: string;
  slug: string;
  kind: 'PERSONAL' | 'ORGANIZATION';
  settings: WorkspaceSettings;
  createdAt: string;
  role: string;
  _count: { memberships: number; scenarios: number };
}

/** General workspace settings (name + workspace-wide policies). */
export default function WorkspaceSettingsPage() {
  const { wsPath, can, href } = useWorkspace();
  const toast = useToast();
  const { mutate: mutateMe } = useMe();
  const { data, error, mutate } = useSWR<WorkspaceDto>(wsPath(''));
  const [name, setName] = useState('');
  const [s, setS] = useState<WorkspaceSettings>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setName(data.name);
      setS(data.settings ?? {});
    }
  }, [data]);

  if (!can('workspace.manage')) return <Alert tone="warning">Only admins can change workspace settings.</Alert>;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return <Loading />;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api(wsPath(''), {
        method: 'PATCH',
        body: {
          name: name.trim(),
          settings: {
            maxSessionMinutes: s.maxSessionMinutes || undefined,
            allowPublicScenarios: s.allowPublicScenarios !== false,
            allowSimulator: s.allowSimulator !== false,
            analyticsVisibleToMembers: !!s.analyticsVisibleToMembers,
          },
        },
      });
      await Promise.all([mutate(), mutateMe()]);
      toast.success('Settings saved');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="Workspace settings" description={`${data.kind === 'PERSONAL' ? 'Personal workspace' : 'Organization'} · created ${formatDay(data.createdAt)}`} />
      <form onSubmit={save} className="space-y-6">
        <Card title="General">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Workspace name">{(id) => <Input id={id} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
            <Field label="Workspace id / slug" hint="Share these with another workspace to receive scenario grants.">
              {(id) => <Input id={id} readOnly value={`${data.id} · ${data.slug}`} />}
            </Field>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {data._count.memberships} member(s) · {data.kind === 'PERSONAL' ? <>Create an organization to invite others.</> : <Link className="text-brand-700 hover:underline" href={href('/settings/members')}>Manage members</Link>}
          </p>
        </Card>
        <Card title="Sessions">
          <div className="space-y-4">
            <Field label="Maximum session length (minutes)" hint="Hard cap for every session in this workspace (a scenario can set a lower limit). 1–240.">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  max={240}
                  className="max-w-[160px]"
                  value={s.maxSessionMinutes ?? ''}
                  placeholder="30"
                  onChange={(e) => setS({ ...s, maxSessionMinutes: e.target.value ? Number(e.target.value) : undefined })}
                />
              )}
            </Field>
            <Checkbox
              label="Allow public scenarios"
              description="When off, scenarios set to Public cannot be run from their public page or the gallery."
              checked={s.allowPublicScenarios !== false}
              onChange={(v) => setS({ ...s, allowPublicScenarios: v })}
            />
            <Checkbox
              label={
                <>
                  Allow the local simulator <Badge tone="yellow">dev</Badge>
                </>
              }
              description="When no AI provider is configured, sessions fall back to a clearly-labeled simulator. Turn off in production to require a real provider."
              checked={s.allowSimulator !== false}
              onChange={(v) => setS({ ...s, allowSimulator: v })}
            />
            <Checkbox
              label="Members can see workspace analytics"
              checked={!!s.analyticsVisibleToMembers}
              onChange={(v) => setS({ ...s, analyticsVisibleToMembers: v })}
            />
          </div>
        </Card>
        <p className="text-sm text-slate-600">
          Data retention and participant data requests live under{' '}
          <Link className="text-brand-700 hover:underline" href={href('/settings/privacy')}>
            Privacy &amp; retention
          </Link>
          .
        </p>
        <Button type="submit" loading={saving}>
          Save settings
        </Button>
      </form>
    </div>
  );
}
