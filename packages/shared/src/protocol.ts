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
  | { type: 'turn.saved'; turn: TurnDTO }
  | { type: 'tool.present'; tool: PresentedTool }
  | { type: 'tool.update'; toolCallId: string; data: Record<string, unknown> }
  | { type: 'tool.close'; toolCallId: string }
  | { type: 'realtime.tool_result'; callId: string; output: string }
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
