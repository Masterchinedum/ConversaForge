'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { mutate } from 'swr';
import { Alert, Button, Card, Field, Input, PageHeader } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function NewWorkspacePage() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  return (
    <main className="mx-auto max-w-lg px-4 py-12">
      <PageHeader title="Create an organization workspace" description="Invite teammates, share scenarios within the organization and manage usage centrally." back={{ href: '/app', label: 'Back' }} />
      <Card>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setLoading(true);
            try {
              const ws = await api<{ id: string }>('/workspaces', { method: 'POST', body: { name } });
              await mutate('/auth/me');
              router.push(`/w/${ws.id}`);
            } catch (err) {
              setError(errorMessage(err));
              setLoading(false);
            }
          }}
        >
          {error && <Alert tone="error">{error}</Alert>}
          <Field label="Organization name" required>
            {(id) => <Input id={id} required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <Button type="submit" loading={loading}>
            Create workspace
          </Button>
        </form>
      </Card>
    </main>
  );
}
