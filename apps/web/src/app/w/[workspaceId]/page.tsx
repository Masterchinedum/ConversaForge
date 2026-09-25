'use client';
import { ButtonLink, Card, PageHeader } from '@/components/ui';
import { useWorkspace } from '@/lib/workspace';

/** Workspace home. The analytics workstream enriches this with live stats. */
export default function DashboardPage() {
  const { workspace, href, can } = useWorkspace();
  return (
    <div>
      <PageHeader title={workspace.name} description="Welcome back." />
      <div className="grid gap-4 md:grid-cols-3">
        {can('scenarios.edit') && (
          <Card title="Create a scenario">
            <p className="mb-3 text-sm text-slate-600">Configure an AI agent for an interview, coaching session, sales call and more.</p>
            <ButtonLink href={href('/scenarios')}>Open scenarios</ButtonLink>
          </Card>
        )}
        <Card title="Practice">
          <p className="mb-3 text-sm text-slate-600">Run assigned scenarios and continue your courses.</p>
          <ButtonLink href={href('/learn')} variant="secondary">
            My learning
          </ButtonLink>
        </Card>
        {can('sessions.review') && (
          <Card title="Review sessions">
            <p className="mb-3 text-sm text-slate-600">Transcripts, recordings, scores and extracted data.</p>
            <ButtonLink href={href('/sessions')} variant="secondary">
              Open sessions
            </ButtonLink>
          </Card>
        )}
      </div>
    </div>
  );
}
