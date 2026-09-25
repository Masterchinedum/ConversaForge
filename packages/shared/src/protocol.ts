import type { SessionState } from './session-state';
import type { SttProviderId, TtsProviderId, VoiceMode } from './scenario-config';

/**
 * Live session wire protocol (JSON over WebSocket at `${API_WS_URL}/ws/session`).
 * The participant authenticates with the per-session token returned when the session is created.
 * Provider-specific audio stays on the client (browser STT/TTS) or goes directly client⇄provider
 * (OpenAI Realtime over WebRTC); this channel carries turns, control, tools and state.
 */

export const PROTOCOL_VERSION = 1;

export interface TurnDTO {
  id: string;
  seq: number;
  speaker: 'AGENT' | 'PARTICIPANT' | 'SYSTEM';
  text: string;
  clientTurnId: string | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  interrupted: boolean;
  source: string | null;
  /** (B, additive) True when the text was produced by the local development simulator. */
  simulated?: boolean;
  /** (B, additive) SYSTEM turns: what kind of event (tool_response | document | notice). */
  kind?: string;
}

export interface ClientRuntimeConfig {
  voiceMode: VoiceMode;
  stt: SttProviderId;
  tts: TtsProviderId;
  language: string;
  voice: { provider: string; voiceId: string; speed: number };
  persona: { name: string; role: string; avatar: { kind: string; imageUrl?: string; accentColor?: string } };
  participantInstructions: string;
  turnTaking: {
    mode: 'vad' | 'push_to_talk';
    endOfTurnSilenceMs: number;
    thinkingPauseGraceMs: number;
    silenceCheckInMs: number;
    allowBargeIn: boolean;
  };
  audio: { echoCancellation: boolean; noiseSuppression: boolean; autoGainControl: boolean; allowCamera: boolean };
  recording: { audio: boolean; video: boolean };
  ui: { showCaptions: boolean; allowTextFallback: boolean; showArtifactPanel: boolean };
  allowParticipantEnd: boolean;
  /** Tools the participant may open themselves (e.g. notepad). */
  participantTools: string[];
  /** True when any part of the pipeline is the local development simulator. */
  simulated: boolean;
  simulatedParts: string[];
  realtime?: { provider: 'openai'; model: string };
  branding?: { displayName?: string; logoUrl?: string; primaryColor?: string; hidePoweredBy?: boolean };
}

export interface SessionSnapshot {
  id: string;
  state: SessionState;
  scenarioName: string;
  startedAt: string | null;
  elapsedMs: number;
  maxDurationSec: number;
  muted: boolean;
  /** (B, additive) Conversation phase: opening | agenda | closing | ended. */
  phase?: string;
  /** (B, additive) Agenda progress for optional progress UI. */
  progress?: { covered: number; total: number };
  /** (B, additive) Voice mode actually used (may differ from the scenario's request after a fallback). */
  voiceMode?: VoiceMode;
  /** (B, additive) Human-readable provider fallbacks (e.g. realtime requested but not configured). */
  fallbacks?: string[];
}

export interface PresentedTool {
  toolCallId: string;
  toolId: string;
  title: string;
  args: Record<string, unknown>;
  /** Tool state that can be updated (e.g. notepad content, selected option). */
  data?: Record<string, unknown>;
  closed?: boolean;
}

/*
 * Protocol notes (runtime, workstream B):
 * - `hello` must be the first message (within 10 s). `lastSeq` (optional) = highest turn seq the client
 *   already has; `welcome.transcript` then contains only turns with a greater seq (full transcript otherwise).
 * - One active connection per session: a newer `hello` supersedes the old socket (closed with SUPERSEDED).
 * - Agent turns stream as agent.start → agent.delta* → agent.end; the persisted turn follows as turn.saved
 *   with the same id as agent.start's turnId. agent.cancel means the generation was dropped (nothing saved).
 * - Send `participant.speaking` true/false around speech and `agent.playback` started/completed/interrupted
 *   (with spokenChars) so barge-in truncation and "wait for the goodbye to finish" work.
 * - Limits: participant.final text ≤ 4000 chars, partial ≤ 2000, tool payloads ≤ 20 KB, client.event data
 *   ≤ 4 KB, ~40 messages/s sustained. Oversized messages get a non-fatal `error` (code "too_large").
 */

// ── Client → Server ──
export type ClientMessage =
  | { type: 'hello'; sessionId: string; token: string; protocol: number; clientInstanceId: string; lastSeq?: number }
  | { type: 'start' }
  | { type: 'participant.partial'; clientTurnId: string; text: string }
  | {
      type: 'participant.final';
      clientTurnId: string;
      text: string;
      startedAtMs?: number;
      endedAtMs?: number;
      confidence?: number;
      source: 'browser_stt' | 'server_stt' | 'typed' | 'realtime' | 'simulated';
    }
  | { type: 'participant.speaking'; speaking: boolean }
  | {
      type: 'agent.playback';
      turnId: string;
      event: 'started' | 'completed' | 'interrupted';
      /** For interruptions: how much of the agent text was actually spoken (chars). */
      spokenChars?: number;
    }
  | { type: 'control'; action: 'pause' | 'resume' | 'end' | 'mute' | 'unmute' }
  | { type: 'tool.open'; toolId: string }
  | { type: 'tool.response'; toolCallId: string; result: Record<string, unknown> }
  | { type: 'tool.update'; toolCallId: string; data: Record<string, unknown> }
  | { type: 'realtime.transcript'; itemId: string; role: 'user' | 'assistant'; text: string; interrupted?: boolean }
  | { type: 'realtime.tool_call'; callId: string; name: string; arguments: string }
  | { type: 'client.event'; name: string; data?: Record<string, unknown> }
  | { type: 'ping'; t: number };

// ── Server → Client ──
export type ServerMessage =
  | {
      type: 'welcome';
      protocol: number;
      session: SessionSnapshot;
      config: ClientRuntimeConfig;
      transcript: TurnDTO[];
      tools: PresentedTool[];
      resumed: boolean;
    }
  | { type: 'state'; state: SessionState; reason?: string }
  | { type: 'agent.start'; turnId: string }
  | { type: 'agent.delta'; turnId: string; text: string }
  | { type: 'agent.end'; turnId: string; text: string; interrupted?: boolean }
  | { type: 'agent.audio'; turnId: string; seq: number; mime: string; data: string; final?: boolean }
  | { type: 'agent.cancel'; turnId: string }
  /**
   * A turn was persisted. May be sent again for the same turn id when it changes (e.g. an agent turn
   * truncated to what was actually spoken after a barge-in) — clients should upsert by `turn.id`.
   */
  | { type: 'turn.saved'; turn: TurnDTO }
  | { type: 'tool.present'; tool: PresentedTool }
  | { type: 'tool.update'; toolCallId: string; data: Record<string, unknown> }
  | { type: 'tool.close'; toolCallId: string }
  | { type: 'realtime.tool_result'; callId: string; output: string }
  /**
   * (B, additive) Realtime mode only: an instruction for the realtime model (timed nudge, wrap-up, closing).
   * The client forwards it on the data channel as a `conversation.item.create` with role "system"
   * (input_text) and, when `respond` is true, follows with `response.create`.
   */
  | { type: 'realtime.instruction'; text: string; respond?: boolean }
  | { type: 'timer'; elapsedMs: number; remainingMs: number }
  | { type: 'notice'; level: 'info' | 'warning'; message: string }
  | { type: 'end'; reason: string; endedBy: string }
  | { type: 'error'; code: string; message: string; fatal: boolean }
  | { type: 'pong'; t: number };

export const WS_CLOSE_CODES = {
  AUTH_FAILED: 4001,
  SESSION_TERMINAL: 4002,
  SUPERSEDED: 4003, // another tab/connection took over this session
  PROTOCOL_ERROR: 4004,
  RATE_LIMITED: 4029,
} as const;
