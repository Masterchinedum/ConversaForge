'use client';
import { useParams } from 'next/navigation';
import { ClassicEditor } from '@/components/scenarios/classic-editor';

/** The legacy editor (Guided / Advanced / YAML / Versions / Preview) on the same draft as Scenario Studio. */
export default function LegacyEditorPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  return <ClassicEditor scenarioId={scenarioId} />;
}
