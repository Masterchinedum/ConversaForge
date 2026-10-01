'use client';
import { MemoryPanel } from '@/components/learning/MemoryPanel';
import { PageHeader } from '@/components/ui';
import { useWorkspace } from '@/lib/workspace';

export default function MyMemoryPage() {
  const { wsPath, href } = useWorkspace();
  return (
    <div>
      <PageHeader
        title="My coach memory"
        description="What AI coaches in this workspace remember about you between sessions. You can turn memory off, disable or delete any fact, or clear everything."
        back={{ href: href('/learn'), label: 'My learning' }}
      />
      <MemoryPanel basePath={wsPath('/coach/me')} self />
    </div>
  );
}
