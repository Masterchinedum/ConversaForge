'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Loading } from '@/components/ui';
import { ClassicEditor } from '@/components/scenarios/classic-editor';
import { ScenarioStudio } from '@/components/scenarios/studio/studio';

/** /scenarios/:id opens Scenario Studio; ?view=classic opens the manual editor on the same draft. */
export default function ScenarioPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ScenarioPageInner />
    </Suspense>
  );
}

function ScenarioPageInner() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const view = useSearchParams().get('view');
  return view === 'classic' ? (
    <div className="px-4 py-6 lg:px-8">
      <ClassicEditor scenarioId={scenarioId} />
    </div>
  ) : (
    <ScenarioStudio key={scenarioId} scenarioId={scenarioId} />
  );
}

