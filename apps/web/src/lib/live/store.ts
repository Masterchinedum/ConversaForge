/**
 * Reducer-based state for the live call: transcript by seq (upsert by turn id, never duplicated),
 * streaming agent text by turnId, optimistic participant turns by clientTurnId, presented tools,
 * session state and timer.
 */

import type { PresentedTool, ServerMessage, SessionSnapshot, SessionState, TurnDTO } from '@cf/shared';
import type { ConnStatus } from './connection';

export interface StreamingTurn {
  id: string;
  speaker: 'AGENT' | 'PARTICIPANT';
  text: string;
  ended: boolean;
  interrupted?: boolean;
}

export interface OptimisticTurn {
  clientTurnId: string;
  text: string;
  at: number;
}

export interface Notice {
  id: number;
  level: 'info' | 'warning' | 'error';
  message: string;
}

export interface LiveState {
  conn: ConnStatus;
  welcomed: boolean;
  session: SessionSnapshot | null;
  state: SessionState | null;
  stateReason: string | null;
  turns: TurnDTO[];
  streaming: StreamingTurn[];
  optimistic: OptimisticTurn[];
  partial: { clientTurnId: string; text: string } | null;
  tools: Record<string, PresentedTool>;
  toolOrder: string[];
  timer: { elapsedMs: number; remainingMs: number; at: number } | null;
  notices: Notice[];
  end: { reason: string; endedBy: string } | null;
  fatal: { kind: string; message: string } | null;
}

export const initialLiveState: LiveState = {
  conn: 'idle',
  welcomed: false,
  session: null,
  state: null,
  stateReason: null,
  turns: [],
  streaming: [],
  optimistic: [],
  partial: null,
  tools: {},
  toolOrder: [],
  timer: null,
  notices: [],
  end: null,
  fatal: null,
};

export type LiveAction =
  | { type: 'server'; msg: ServerMessage }
  | { type: 'conn'; status: ConnStatus }
  | { type: 'fatal'; kind: string; message: string }
  | { type: 'clearFatal' }
  | { type: 'local.partial'; clientTurnId: string; text: string }
  | { type: 'local.clearPartial' }
  | { type: 'local.final'; clientTurnId: string; text: string }
  | { type: 'local.realtimeDelta'; itemId: string; role: 'user' | 'assistant'; text: string }
  | { type: 'local.tool'; toolCallId: string; data: Record<string, unknown> }
  | { type: 'notice'; level: Notice['level']; message: string }
  | { type: 'dismissNotice'; id: number };

let noticeSeq = 1;

export function upsertTurn(turns: TurnDTO[], turn: TurnDTO): TurnDTO[] {
  const idx = turns.findIndex((t) => t.id === turn.id || (turn.clientTurnId && t.clientTurnId === turn.clientTurnId));
  let next: TurnDTO[];
  if (idx >= 0) {
    next = turns.slice();
    next[idx] = turn;
  } else {
    // Different id but same seq → the server's version wins (seq is unique per session).
    next = turns.filter((t) => t.seq !== turn.seq).concat(turn);
  }
  next.sort((a, b) => a.seq - b.seq);
  return next;
}

function addNotice(s: LiveState, level: Notice['level'], message: string): LiveState {
  // Collapse repeats of the same message.
  if (s.notices.some((n) => n.message === message)) return s;
  const notices = [...s.notices, { id: noticeSeq++, level, message }].slice(-4);
  return { ...s, notices };
}

function withTool(s: LiveState, tool: PresentedTool): LiveState {
  const tools = { ...s.tools, [tool.toolCallId]: { ...s.tools[tool.toolCallId], ...tool } };
  const toolOrder = s.toolOrder.includes(tool.toolCallId) ? s.toolOrder : [...s.toolOrder, tool.toolCallId];
  return { ...s, tools, toolOrder };
}

export function liveReducer(s: LiveState, a: LiveAction): LiveState {
  switch (a.type) {
    case 'conn':
      return { ...s, conn: a.status, welcomed: a.status === 'open' ? s.welcomed : false };
    case 'fatal':
      return { ...s, fatal: { kind: a.kind, message: a.message } };
    case 'clearFatal':
      return { ...s, fatal: null };
    case 'notice':
      return addNotice(s, a.level, a.message);
    case 'dismissNotice':
      return { ...s, notices: s.notices.filter((n) => n.id !== a.id) };
    case 'local.partial':
      return { ...s, partial: { clientTurnId: a.clientTurnId, text: a.text } };
    case 'local.clearPartial':
      return { ...s, partial: null };
    case 'local.final': {
      if (s.turns.some((t) => t.clientTurnId === a.clientTurnId) || s.optimistic.some((o) => o.clientTurnId === a.clientTurnId)) {
        return { ...s, partial: s.partial?.clientTurnId === a.clientTurnId ? null : s.partial };
      }
      return {
        ...s,
        partial: s.partial?.clientTurnId === a.clientTurnId ? null : s.partial,
        optimistic: [...s.optimistic, { clientTurnId: a.clientTurnId, text: a.text, at: Date.now() }],
      };
    }
    case 'local.realtimeDelta': {
      if (s.turns.some((t) => t.clientTurnId === a.itemId || t.id === a.itemId)) return s;
      const speaker = a.role === 'user' ? 'PARTICIPANT' : 'AGENT';
      const existing = s.streaming.find((t) => t.id === a.itemId);
      const streaming = existing
        ? s.streaming.map((t) => (t.id === a.itemId ? { ...t, text: a.text } : t))
        : [...s.streaming, { id: a.itemId, speaker, text: a.text, ended: false } as StreamingTurn];
      return { ...s, streaming };
    }
    case 'local.tool': {
      const t = s.tools[a.toolCallId];
      if (!t) return s;
      return { ...s, tools: { ...s.tools, [a.toolCallId]: { ...t, data: { ...(t.data ?? {}), ...a.data } } } };
    }
    case 'server':
      return serverReducer(s, a.msg);
  }
}

function serverReducer(s: LiveState, m: ServerMessage): LiveState {
  switch (m.type) {
    case 'welcome': {
      let turns = s.turns;
      for (const t of m.transcript) turns = upsertTurn(turns, t);
      let next: LiveState = {
        ...s,
        welcomed: true,
        session: m.session,
        state: m.session.state,
        turns,
        // Anything that was mid-stream before the reconnect is superseded by the saved transcript.
        streaming: s.streaming.filter((st) => !turns.some((t) => t.id === st.id)),
        optimistic: s.optimistic.filter((o) => !turns.some((t) => t.clientTurnId === o.clientTurnId)),
        timer: {
          elapsedMs: m.session.elapsedMs,
          remainingMs: Math.max(0, m.session.maxDurationSec * 1000 - m.session.elapsedMs),
          at: Date.now(),
        },
        fatal: null,
      };
      for (const tool of m.tools) next = withTool(next, tool);
      return next;
    }
    case 'state':
      return { ...s, state: m.state, stateReason: m.reason ?? null, session: s.session ? { ...s.session, state: m.state } : s.session };
    case 'agent.start':
      if (s.turns.some((t) => t.id === m.turnId) || s.streaming.some((t) => t.id === m.turnId)) return s;
      return { ...s, streaming: [...s.streaming, { id: m.turnId, speaker: 'AGENT', text: '', ended: false }] };
    case 'agent.delta': {
      if (s.turns.some((t) => t.id === m.turnId)) return s;
      const exists = s.streaming.some((t) => t.id === m.turnId);
      const streaming = exists
        ? s.streaming.map((t) => (t.id === m.turnId ? { ...t, text: t.text + m.text } : t))
        : [...s.streaming, { id: m.turnId, speaker: 'AGENT' as const, text: m.text, ended: false }];
      return { ...s, streaming };
    }
    case 'agent.end': {
      if (s.turns.some((t) => t.id === m.turnId)) return { ...s, streaming: s.streaming.filter((t) => t.id !== m.turnId) };
      const exists = s.streaming.some((t) => t.id === m.turnId);
      const streaming = exists
        ? s.streaming.map((t) => (t.id === m.turnId ? { ...t, text: m.text || t.text, ended: true, interrupted: m.interrupted } : t))
        : [...s.streaming, { id: m.turnId, speaker: 'AGENT' as const, text: m.text, ended: true, interrupted: m.interrupted }];
      return { ...s, streaming };
    }
    case 'agent.cancel':
      return { ...s, streaming: s.streaming.filter((t) => t.id !== m.turnId) };
    case 'turn.saved': {
      const turn = m.turn;
      const turns = upsertTurn(s.turns, turn);
      return {
        ...s,
        turns,
        streaming: s.streaming.filter((t) => t.id !== turn.id && t.id !== turn.clientTurnId),
        optimistic: s.optimistic.filter((o) => o.clientTurnId !== turn.clientTurnId),
        partial: s.partial && s.partial.clientTurnId === turn.clientTurnId ? null : s.partial,
      };
    }
    case 'tool.present':
      return withTool(s, { ...m.tool, closed: false });
    case 'tool.update': {
      const t = s.tools[m.toolCallId];
      if (!t) return s;
      return { ...s, tools: { ...s.tools, [m.toolCallId]: { ...t, data: { ...(t.data ?? {}), ...m.data } } } };
    }
    case 'tool.close': {
      const t = s.tools[m.toolCallId];
      if (!t) return s;
      return { ...s, tools: { ...s.tools, [m.toolCallId]: { ...t, closed: true } } };
    }
    case 'timer':
      return { ...s, timer: { elapsedMs: m.elapsedMs, remainingMs: m.remainingMs, at: Date.now() } };
    case 'notice':
      return addNotice(s, m.level, m.message);
    case 'end':
      return { ...s, end: { reason: m.reason, endedBy: m.endedBy } };
    case 'error':
      return m.fatal ? { ...s, fatal: { kind: m.code, message: m.message } } : addNotice(s, 'warning', m.message);
    default:
      return s;
  }
}

/** Transcript rows for rendering: saved turns, then in-flight ones (optimistic + streaming). */
export interface TranscriptRow {
  key: string;
  speaker: 'AGENT' | 'PARTICIPANT' | 'SYSTEM';
  text: string;
  status: 'saved' | 'sending' | 'streaming' | 'partial';
  interrupted?: boolean;
  simulated?: boolean;
  kind?: string;
}

export function transcriptRows(s: LiveState): TranscriptRow[] {
  const rows: TranscriptRow[] = s.turns.map((t) => ({
    key: t.id,
    speaker: t.speaker,
    text: t.text,
    status: 'saved',
    interrupted: t.interrupted,
    simulated: t.simulated,
    kind: t.kind,
  }));
  for (const o of s.optimistic) rows.push({ key: `o:${o.clientTurnId}`, speaker: 'PARTICIPANT', text: o.text, status: 'sending' });
  for (const st of s.streaming) {
    if (!st.text) continue;
    rows.push({ key: `s:${st.id}`, speaker: st.speaker, text: st.text, status: 'streaming', interrupted: st.interrupted });
  }
  if (s.partial?.text) rows.push({ key: `p:${s.partial.clientTurnId}`, speaker: 'PARTICIPANT', text: s.partial.text, status: 'partial' });
  return rows;
}
