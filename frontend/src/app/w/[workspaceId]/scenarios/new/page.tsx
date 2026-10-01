'use client';
import { ScenarioStudio } from '@/components/scenarios/studio/studio';

/** "Create scenario" opens Scenario Studio on a new, not-yet-stored draft. */
export default function NewScenarioPage() {
  return <ScenarioStudio scenarioId={null} />;
}
