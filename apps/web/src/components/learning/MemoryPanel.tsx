'use client';
/**
 * Coach memory controls for one learner. Used by the learner (/learn/memory → /coach/me) and by
 * reviewers (/coach → /coach/learners/:participantId, audited server-side).
 */
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { Alert, Badge, Button, Card, Checkbox, ConfirmButton, EmptyState, ErrorState, Field, Loading, SimulatedBadge, Table, Td, Textarea, Th, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';
import { formatDate } from '@/lib/format';

export interface MemoryFactDto {
  id: string;
  category: string;
  content: string;
  confidence: number | null;
  disabled: boolean;
  simulated: boolean;
  scenarioName: string | null;
  sourceSessionId: string | null;
  createdAt: string;
}
export interface MemoryDetail {
  learner?: { participantId: string; name: string | null; email: string | null; hasAccount: boolean };
  profile: { memoryEnabled: boolean; goals: string | null; summary: string | null };
  facts: MemoryFactDto[];
}

const CATEGORY_TONE: Record<string, 'gray' | 'green' | 'yellow' | 'red' | 'blue' | 'purple'> = {
  goal: 'purple',
  strength: 'green',
  weakness: 'yellow',
  preference: 'blue',
  context: 'gray',
  progress: 'gray',
};

export function MemoryPanel({ basePath, self, onChanged }: { basePath: string; self: boolean; onChanged?: () => void }) {
  const toast = useToast();
  const { data, error, isLoading, mutate } = useSWR<MemoryDetail>(basePath);
  const [goals, setGoals] = useState('');
  const [savingGoals, setSavingGoals] = useState(false);
  useEffect(() => setGoals(data?.profile.goals ?? ''), [data?.profile.goals]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await mutate();
      onChanged?.();
      toast.success(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  if (isLoading) return <Loading />;
  if (error) return <ErrorState error={error} retry={() => mutate()} />;
  if (!data) return null;
  const who = self ? 'you' : 'this learner';

  return (
    <div className="space-y-4">
      <Card title="Memory settings">
        <div className="space-y-4">
          <Checkbox
            label="Remember things between coaching sessions"
            description={
              self
                ? 'When on, coaching scenarios that use memory can recall your goals and past practice. Turning it off stops both using and learning new facts.'
                : 'When off, no facts are used in sessions or learned from new sessions for this learner.'
            }
            checked={data.profile.memoryEnabled}
            onChange={(v) => act(() => api(basePath, { method: 'PATCH', body: { memoryEnabled: v } }), v ? 'Memory turned on' : 'Memory turned off')}
          />
          <Field label="Goals" hint={`Shared with the coach as context about ${who}. Keep it to professional goals.`}>
            {(id) => <Textarea id={id} rows={3} maxLength={2000} value={goals} onChange={(e) => setGoals(e.target.value)} />}
          </Field>
          <Button
            size="sm"
            variant="secondary"
            loading={savingGoals}
            disabled={goals === (data.profile.goals ?? '')}
            onClick={async () => {
              setSavingGoals(true);
              await act(() => api(basePath, { method: 'PATCH', body: { goals: goals.trim() || null } }), 'Goals saved');
              setSavingGoals(false);
            }}
          >
            Save goals
          </Button>
        </div>
      </Card>

      <Card
        title={`Remembered facts (${data.facts.length})`}
        actions={
          data.facts.length > 0 && (
            <ConfirmButton
              size="sm"
              variant="danger"
              confirmText={`Permanently delete all ${data.facts.length} remembered facts about ${who}?`}
              onConfirm={() => act(() => api(`${basePath}/facts`, { method: 'DELETE' }), 'Memory cleared')}
            >
              Clear all
            </ConfirmButton>
          )
        }
      >
        {!data.profile.memoryEnabled && (
          <div className="mb-3">
            <Alert tone="warning">Memory is off — these facts are not used in sessions.</Alert>
          </div>
        )}
        {data.facts.length === 0 ? (
          <EmptyState title="Nothing remembered yet" description="Facts are learned after coaching sessions whose scenario has memory enabled." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Fact</Th>
                <Th>Type</Th>
                <Th>From</Th>
                <Th>Status</Th>
                <Th className="text-right">Actions</Th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.facts.map((f) => (
                <tr key={f.id} className={f.disabled ? 'opacity-60' : ''}>
                  <Td className="max-w-md whitespace-normal">
                    <span className="text-slate-900">{f.content}</span>
                    {f.simulated && (
                      <span className="ml-2">
                        <SimulatedBadge />
                      </span>
                    )}
                  </Td>
                  <Td>
                    <Badge tone={CATEGORY_TONE[f.category] ?? 'gray'}>{f.category}</Badge>
                  </Td>
                  <Td className="text-xs">
                    {f.scenarioName ?? '—'}
                    <br />
                    <span className="text-slate-500">{formatDate(f.createdAt)}</span>
                  </Td>
                  <Td>{f.disabled ? <Badge>Disabled</Badge> : <Badge tone="green">Active</Badge>}</Td>
                  <Td className="text-right">
                    <div className="flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          act(() => api(`${basePath}/facts/${f.id}`, { method: 'PATCH', body: { disabled: !f.disabled } }), f.disabled ? 'Fact enabled' : 'Fact disabled')
                        }
                      >
                        {f.disabled ? 'Enable' : 'Disable'}
                      </Button>
                      <ConfirmButton
                        size="sm"
                        variant="ghost"
                        confirmText="Delete this fact permanently?"
                        onConfirm={() => act(() => api(`${basePath}/facts/${f.id}`, { method: 'DELETE' }), 'Fact deleted')}
                      >
                        Delete
                      </ConfirmButton>
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
