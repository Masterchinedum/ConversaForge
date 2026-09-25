import { ScenarioConfigSchema, defaultScenarioConfig, type ScenarioConfig } from '@cf/shared';

export const PIPELINE_STEPS = ['finalize_transcript', 'score', 'extract', 'report', 'notify'] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export const STEP_LABELS: Record<PipelineStep, string> = {
  finalize_transcript: 'Finalize transcript',
  score: 'Score against rubric',
  extract: 'Extract variables',
  report: 'Build report',
  notify: 'Notify reviewers',
};

export interface StepJobData {
  sessionId: string;
  workspaceId: string;
  step: PipelineStep;
  generation: number;
}

/** Deterministic job id / ProcessingJob idempotency key: one per (session, step, generation). */
export function pipelineJobKey(sessionId: string, step: PipelineStep, generation: number): string {
  return `pipeline_${sessionId}_${step}_g${generation}`;
}

export function isPipelineStep(s: string): s is PipelineStep {
  return (PIPELINE_STEPS as readonly string[]).includes(s);
}

/** A failure that retrying will not fix (bad config, provider not configured…). */
export class NonRetryableError extends Error {
  constructor(message: string, readonly code = 'non_retryable') {
    super(message);
  }
}

export interface StepOutcome {
  status: 'COMPLETED' | 'SKIPPED';
  result: Record<string, unknown>;
}

/** Version configs are validated at publish time; parse defensively anyway (older schema versions). */
export function parseVersionConfig(raw: unknown): ScenarioConfig {
  const r = ScenarioConfigSchema.safeParse(raw ?? {});
  return r.success ? r.data : defaultScenarioConfig();
}

export const TERMINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'SKIPPED'] as const;
