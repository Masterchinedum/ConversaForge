// Response shapes of the analysis/review API (workstream D).

export type ProcessingStatus = 'NOT_STARTED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';

export interface SessionRow {
  id: string;
  participant: { id: string; name: string | null; email: string | null; externalId: string | null };
  scenario: { id: string; name: string; type: string };
  version: { id: string; number: number };
  channel: string;
  state: string;
  durationMs: number | null;
  overallScore: number | null;
  insufficientEvidence: boolean | null;
  analysisStatus: ProcessingStatus;
  analysisError: string | null;
  simulated: boolean;
  humanReviewRequired: boolean;
  reviewed: boolean;
  startedAt: string | null;
  endedAt: string | null;
  createdAt: string;
}

export interface Facets {
  scenarios: Array<{ id: string; name: string; versions: Array<{ id: string; number: number }> }>;
  courses: Array<{ id: string; title: string }>;
  teams: Array<{ id: string; name: string }>;
}

export interface EvidenceQuote {
  turnSeq: number;
  quote: string;
}

export interface CriterionResult {
  criterionId: string;
  name: string;
  description: string;
  weight: number;
  score: number | null;
  insufficientEvidence: boolean;
  confidence: number | null;
  rationale: string | null;
  evidence: EvidenceQuote[];
}

export interface Turn {
  id: string;
  seq: number;
  speaker: 'AGENT' | 'PARTICIPANT' | 'SYSTEM';
  text: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  interrupted: boolean;
  confidence: number | null;
  source: string | null;
}

export interface ToolEventRow {
  id: string;
  toolId: string;
  toolCallId: string;
  kind: string;
  actor: string;
  args: unknown;
  result: unknown;
  createdAt: string;
}

export interface SessionDetail {
  session: {
    id: string;
    state: string;
    stateReason: string | null;
    endedBy: string | null;
    channel: string;
    coachMode: boolean;
    consent: Record<string, unknown>;
    providerInfo: Record<string, any>;
    variables: Record<string, unknown>;
    metadata: Record<string, unknown>;
    errorCode: string | null;
    errorMessage: string | null;
    /** Set when the retention policy redacted transcript text and removed media. */
    contentRedactedAt?: string | null;
    analysisStatus: ProcessingStatus;
    analysisError: string | null;
    analysisGeneration: number;
    createdAt: string;
    startedAt: string | null;
    endedAt: string | null;
    durationMs: number | null;
    retentionUntil: string | null;
  };
  scenario: { id: string; name: string; type: string; status: string; latestVersionNumber: number };
  version: { id: string; number: number; publishedAt: string; isLatest: boolean };
  analysisSettings: {
    enabled: boolean;
    participantCanSeeTranscript: boolean;
    participantCanSeeFeedback: boolean;
    participantCanSeeScores: boolean;
    requireHumanReview: boolean;
    notifyOnComplete: boolean;
  };
  rubric: { enabled: boolean; evaluatedSubject: string; passingScore: number | null; minEvidenceCoverage: number; visibility: string };
  participant: { id: string; name: string | null; email: string | null; externalId: string | null; userId: string | null };
  turns: Turn[];
  toolEvents: ToolEventRow[];
  evaluation: null | {
    id: string;
    generation: number;
    overallScore: number | null;
    coverage: number | null;
    insufficientEvidence: boolean;
    passed: boolean | null;
    summary: string | null;
    strengths: string[];
    weaknesses: string[];
    improvements: string[];
    notes: Array<{ text: string; turnSeqs: number[] }>;
    provider: string | null;
    model: string | null;
    promptVersion: string | null;
    simulated: boolean;
    humanReviewRequired: boolean;
    reviewedAt: string | null;
    reviewedBy: { id: string; name: string | null; email: string } | null;
    reviewNote: string | null;
    completedAt: string | null;
    criteria: CriterionResult[];
  };
  evaluationHistory: Array<{ id: string; generation: number; overallScore: number | null; simulated: boolean; isCurrent: boolean; createdAt: string; provider: string | null; model: string | null }>;
  extraction: Array<{
    key: string;
    type: string;
    description: string;
    value: unknown;
    valid: boolean;
    errors: string[];
    evidence: Array<{ turnSeq: number; speaker?: string; excerpt?: string }>;
    confidence: number | null;
    simulated: boolean;
  }>;
  processing: {
    status: ProcessingStatus;
    error: string | null;
    generation: number;
    steps: Array<{ step: string; label: string; status: ProcessingStatus; attempts: number; lastError: string | null; result: any; startedAt: string | null; finishedAt: string | null }>;
  };
  media: Array<{ id: string; kind: string; mimeType: string; fileName: string | null; sizeBytes: number; durationMs: number | null; status: string; createdAt: string; url: string | null }>;
  recordingUnavailableReason: string | null;
  report: Record<string, any> | null;
  events: Array<{ id: string; type: string; payload: unknown; createdAt: string }> | null;
}

export interface ParticipantReport {
  session: { id: string; state: string; createdAt: string; endedAt: string | null; durationMs: number | null };
  scenario: { name: string; description: string | null };
  workspace: { name: string };
  branding: { logoUrl: string | null; primaryColor: string | null; hidePoweredBy: boolean } | null;
  processing: { status: ProcessingStatus; pending: boolean; message: string | null };
  visibility: { transcript: boolean; feedback: boolean; scores: boolean };
  simulated: boolean;
  transcript: Array<{ seq: number; speaker: 'AGENT' | 'PARTICIPANT'; text: string; startedAtMs: number | null }> | null;
  feedback: { summary: string | null; strengths: string[]; weaknesses: string[]; improvements: string[]; simulated: boolean } | null;
  scores:
    | null
    | { awaitingReview: true }
    | {
        awaitingReview: false;
        overallScore: number | null;
        insufficientEvidence: boolean;
        criteria: Array<{ name: string; weight: number; score: number | null; insufficientEvidence: boolean }>;
      };
}
