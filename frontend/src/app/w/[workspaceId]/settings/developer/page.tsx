'use client';
import Link from 'next/link';
import { Alert, Card, PageHeader } from '@/components/ui';
import { useWorkspace } from '@/lib/workspace';
import { ApiKeysSection } from './api-keys';
import { WebhooksSection } from './webhooks';

export default function DeveloperSettingsPage() {
  const { can, workspaceId } = useWorkspace();
  if (!can('apikeys.manage') && !can('webhooks.manage')) {
    return <Alert tone="warning" title="Admins only">You need the admin role to manage API keys and webhooks.</Alert>;
  }
  return (
    <div className="space-y-6">
      <PageHeader
        title="API & webhooks"
        description="Integrate ConversaForge with your systems: REST API keys with scopes, and signed webhooks for session events."
        actions={
          <>
            <Link href="/docs/api" className="text-sm text-brand-700 hover:underline">
              API guide
            </Link>
            <a href="/api/docs" target="_blank" rel="noreferrer" className="text-sm text-brand-700 hover:underline">
              OpenAPI reference ↗
            </a>
          </>
        }
      />
      <Card title="Quick start">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
          <li>Create an API key with the scopes you need.</li>
          <li>
            Call the API: <code className="rounded bg-slate-100 px-1 text-xs">curl -H &quot;Authorization: Bearer cf_live_…&quot; {typeof window !== 'undefined' ? window.location.origin : ''}/api/v1/scenarios</code>
          </li>
          <li>Add a webhook endpoint and verify the signature on every request.</li>
        </ol>
        <p className="mt-2 text-xs text-slate-500">
          Workspace id: <code>{workspaceId}</code> (API keys are bound to this workspace; no id is needed in v1 URLs).
        </p>
      </Card>
      {can('apikeys.manage') && <ApiKeysSection />}
      {can('webhooks.manage') && <WebhooksSection />}
    </div>
  );
}
