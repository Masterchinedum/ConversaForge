import type { SttProviderId, TtsProviderId, VoiceMode } from '@cf/shared';

/** Stored in Session.consent. */
export interface ConsentRecord {
  recordAudio: boolean;
  recordVideo: boolean;
  /** false → workstream D must skip scoring/extraction for this session. */
  analysis: boolean;
  acceptedAt: string;
  /** sha256 prefix of the consent notice text the participant saw. */
  noticeVersion: string;
  /** Where the consent came from: participant UI, phone greeting, API caller… */
  source?: string;
}

/** Stored in Session.providerInfo. Describes what the runtime will use for this session. */
export interface ProviderInfo {
  voiceMode: VoiceMode;
  /** The voice mode the scenario asked for (differs from voiceMode when we had to fall back). */
  requestedVoiceMode: VoiceMode;
  llm: { provider: 'anthropic' | 'openai' | 'simulator'; model: string; source: 'workspace' | 'environment' | 'simulator' };
  stt: SttProviderId;
  tts: TtsProviderId;
  realtime?: { provider: 'openai'; model: string };
  simulated: boolean;
  simulatedParts: string[];
  /** Human-readable reasons for any fallback (e.g. realtime requested but no OpenAI key). */
  fallbacks: string[];
}

export type Phase = 'opening' | 'agenda' | 'closing' | 'ended';

export interface PendingInstruction {
  id: string;
  kind: 'nudge' | 'wrap_up' | 'end' | 'system';
  text: string;
  createdAtMs: number;
}

/** Simulator bookkeeping (only used when the LLM is the local simulator). */
export interface SimulatorState {
  /** Index into the agenda of the topic currently being discussed (-1 = not started). */
  topicIndex: number;
  followUps: number;
  /** The last question the simulated agent asked (for "can you repeat that"). */
  lastQuestion: string;
  closingAsked: boolean;
  waitingForMoment: boolean;
}

/**
 * Stored in Session.runtimeState. Everything the engine needs to rebuild itself after an API restart
 * (together with the transcript turns and tool events).
 */
export interface RuntimeState {
  phase: Phase;
  coveredTopicIds: string[];
  currentTopicId: string | null;
  followUpsUsed: Record<string, number>;
  firedTimedInstructionIds: string[];
  pendingInstructions: PendingInstruction[];
  wrapUpSent: boolean;
  /** Accumulated ACTIVE/ENDING time before `activeSince`. */
  activeMs: number;
  /** ISO time when the current ACTIVE stretch began (null when not counting). */
  activeSince: string | null;
  pausedAt: string | null;
  disconnectedAt: string | null;
  /** Heartbeat so orphaned sessions (API crashed) can be detected by the sweeper. */
  heartbeatAt: string | null;
  endRequested: { reason: string; by: string; closingTurnId?: string | null } | null;
  /** Tools currently shown to the participant (tool.present), keyed by toolCallId. */
  presentedTools: Array<{
    toolCallId: string;
    toolId: string;
    title: string;
    args: Record<string, unknown>;
    data?: Record<string, unknown>;
    closed?: boolean;
    /** Result waiting to be delivered to the agent with the next user message. */
    awaitingResponse?: boolean;
  }>;
  /** Tool responses from the participant to be delivered to the agent on its next turn. */
  pendingToolResponses: Array<{ toolCallId: string; toolId: string; content: string }>;
  consecutiveLlmFailures: number;
  muted: boolean;
  sim: SimulatorState;
  realtimeStartedAt?: string | null;
}

export function initialRuntimeState(): RuntimeState {
  return {
    phase: 'opening',
    coveredTopicIds: [],
    currentTopicId: null,
    followUpsUsed: {},
    firedTimedInstructionIds: [],
    pendingInstructions: [],
    wrapUpSent: false,
    activeMs: 0,
    activeSince: null,
    pausedAt: null,
    disconnectedAt: null,
    heartbeatAt: null,
    endRequested: null,
    presentedTools: [],
    pendingToolResponses: [],
    consecutiveLlmFailures: 0,
    muted: false,
    sim: { topicIndex: -1, followUps: 0, lastQuestion: '', closingAsked: false, waitingForMoment: false },
    realtimeStartedAt: null,
  };
}

/** Merge a (possibly older-shaped) stored runtimeState with defaults. */
export function hydrateRuntimeState(raw: unknown): RuntimeState {
  const base = initialRuntimeState();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Partial<RuntimeState>;
  return { ...base, ...r, sim: { ...base.sim, ...(r.sim ?? {}) } };
}
