'use client';
import { useParams } from 'next/navigation';
import { ScenarioStudio } from '@/components/scenarios/studio/studio';

/** Scenario Studio for an existing scenario (Edit on the scenario page). */
export default function ScenarioStudioPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  return <ScenarioStudio key={scenarioId} scenarioId={scenarioId} />;
}
