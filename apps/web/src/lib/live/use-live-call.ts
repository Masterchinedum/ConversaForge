'use client';
/**
 * useLiveCall — wires the WebSocket session connection, the reducer store, the voice adapter and the
 * recorder together for the call screen.
 */

import { isTerminal, type ClientMessage, type ClientRuntimeConfig, type ServerMessage, type SessionState } from '@cf/shared';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { wsUrl } from '../api';
import {
  createVoiceClient,
  detectCapabilities,
  planVoice,
  unavailableKeyFor,
  type VoiceClient,
  type VoiceMode,
  type VoicePlan,
} from '../voice';
import { SentenceChunker } from '../voice/synth';
import { SessionConnection, type FatalKind } from './connection';
import { CallRecorder } from './recorder';
import { initialLiveState, liveReducer } from './store';
import { clientInstanceId, randomId } from './token';

export interface CallDevices {
  micStream: MediaStream | null;
  cameraStream: MediaStream | null;
  audioContext: AudioContext | null;
  preferTyped: boolean;
}

export interface LifecycleEvent {
  type: 'session.state' | 'session.ended' | 'error';
  data: Record<string, unknown>;
}

export interface UseLiveCallOptions {
  sessionId: string;
  token: string;
  config: ClientRuntimeConfig;
  devices: CallDevices;
  consent: { recordAudio: boolean; recordVideo: boolean; analysis: boolean } | null;
  onLifecycle?: (e: LifecycleEvent) => void;
}

const SPEAKABLE_STATES: SessionState[] = ['ACTIVE', 'ENDING', 'CONNECTING'];

export function useLiveCall(o: UseLiveCallOptions) {
  const [state, dispatch] = useReducer(liveReducer, initialLiveState);
  const [voiceMode, setVoiceMode] = useState<VoiceMode | null>(null);
  const [voicePlan, setVoicePlan] = useState<VoicePlan | null>(null);
  const [muted, setMutedState] = useState(false);
  const [ptt, setPttState] = useState(o.config.turnTaking.mode === 'push_to_talk');
  const [talking, setTalkingState] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [agentSpeaking, setAgentSpeaking] = useState(false);
  const [participantSpeaking, setParticipantSpeaking] = useState(false);
  const [recording, setRecording] = useState(false);
  const [ending, setEnding] = useState(false);

  const connRef = useRef<SessionConnection | null>(null);
  const voiceRef = useRef<VoiceClient | null>(null);
  const voiceUnsubs = useRef<Array<() => void>>([]);
  const recorderRef = useRef<CallRecorder | null>(null);
  const chunkers = useRef(new Map<string, SentenceChunker>());
  const spokenTurns = useRef(new Set<string>());
  const startedAtRef = useRef<number>(Date.now());
  const unavailable = useRef(new Set<string>());
  const levelSubs = useRef(new Set<(l: number) => void>());
  const lastSpeaking = useRef<boolean | null>(null);
  const sessionState = useRef<SessionState | null>(null);
  const tornDown = useRef(false);
  const optsRef = useRef(o);
  optsRef.current = o;
  /** Latest runtime config from the server (welcome) — authoritative over the bootstrap copy. */
  const configRef = useRef<ClientRuntimeConfig>(o.config);
  const pttRef = useRef(ptt);
  pttRef.current = ptt;
  const mutedRef = useRef(false);

  const send = useCallback((m: ClientMessage) => connRef.current?.send(m), []);
  const lifecycle = useCallback((e: LifecycleEvent) => optsRef.current.onLifecycle?.(e), []);

  // ── Voice adapter ──
  const buildVoice = useCallback(
    async (agentSpeaksFirst: boolean) => {
      const { devices, sessionId, token } = optsRef.current;
      const config = configRef.current;
      const caps = detectCapabilities();
      const hasMic = !!devices.micStream?.getAudioTracks().some((t) => t.readyState === 'live');
      const plan = planVoice(config, caps, { hasMic, unavailable: unavailable.current, preferTyped: devices.preferTyped });
      voiceUnsubs.current.forEach((u) => u());
      voiceUnsubs.current = [];
      voiceRef.current?.stop();
      const vc = createVoiceClient(
        plan,
        config,
        {
          sessionId,
          token,
          language: config.language,
          voice: config.voice,
          turnTaking: config.turnTaking,
          micStream: devices.micStream,
          audioContext: devices.audioContext,
          recordingSink: recorderRef.current?.sink ?? null,
          serverTts: plan.output === 'server',
          speakInTypedMode: plan.output !== 'none',
          sessionStartedAt: () => startedAtRef.current,
        },
        { agentSpeaksFirst },
      );
      voiceRef.current = vc;
      setVoicePlan(plan);
      setVoiceMode(vc.mode);
      if (plan.reason && vc.mode !== 'realtime') dispatch({ type: 'notice', level: 'info', message: plan.reason });
      const u = voiceUnsubs.current;
      u.push(
        vc.on('partial', (text, clientTurnId) => {
          dispatch({ type: 'local.partial', clientTurnId, text });
          if (vc.mode !== 'realtime') send({ type: 'participant.partial', clientTurnId, text: text.slice(0, 2000) });
        }),
        vc.on('final', (text, meta) => {
          const clean = text.trim().slice(0, 4000);
          if (!clean) return;
          dispatch({ type: 'local.final', clientTurnId: meta.clientTurnId, text: clean });
          send({
            type: 'participant.final',
            clientTurnId: meta.clientTurnId,
            text: clean,
            startedAtMs: meta.startedAtMs,
            endedAtMs: meta.endedAtMs,
            confidence: meta.confidence,
            source: meta.source,
          });
        }),
        vc.on('speaking', (s) => {
          setParticipantSpeaking(s);
          if (lastSpeaking.current === s) return;
          lastSpeaking.current = s;
          if (vc.mode !== 'realtime') send({ type: 'participant.speaking', speaking: s });
        }),
        vc.on('playback', (turnId, event, spokenChars) => {
          if (vc.mode === 'realtime') return;
          send({ type: 'agent.playback', turnId, event, ...(event === 'interrupted' ? { spokenChars } : {}) });
        }),
        vc.on('thinking', (w) => setThinking(w)),
        vc.on('agentSpeaking', (a) => setAgentSpeaking(a)),
        vc.on('level', (l) => levelSubs.current.forEach((f) => f(l))),
        vc.on('notice', (m) => dispatch({ type: 'notice', level: 'info', message: m })),
        vc.on('realtimeDelta', (e) => dispatch({ type: 'local.realtimeDelta', ...e })),
        vc.on('realtimeTranscript', (e) => send({ type: 'realtime.transcript', ...e })),
        vc.on('realtimeToolCall', (e) => send({ type: 'realtime.tool_call', ...e })),
        vc.on('error', (err) => {
          if (!err.fallback || tornDown.current) {
            dispatch({ type: 'notice', level: 'warning', message: err.message });
            return;
          }
          for (const k of unavailableKeyFor(vc.mode, err.code)) unavailable.current.add(k);
          send({ type: 'client.event', name: 'voice.fallback', data: { from: vc.mode, code: err.code } });
          // Re-plan on the next tick (don't tear down an adapter from inside its own callback).
          setTimeout(() => {
            if (tornDown.current || voiceRef.current !== vc) return;
            void buildVoice(false).then(() => {
              const now = voiceRef.current;
              if (now) dispatch({ type: 'notice', level: 'warning', message: `${err.message} Now using: ${modeLabel(now.mode)}.` });
            });
          }, 0);
        }),
      );
      vc.setPushToTalk(pttRef.current);
      vc.setMuted(mutedRef.current);
      try {
        await vc.start();
        send({ type: 'client.event', name: 'voice.mode', data: { mode: vc.mode, output: plan.output } });
      } catch (e) {
        // Adapters emit a fallback error before throwing; the handler above re-plans.
        if (voiceRef.current === vc && vc.mode === 'typed') console.warn('[live] typed adapter failed to start', e);
      }
    },
    [send],
  );

  // ── Recording ──
  /** Create the recorder (and its agent-audio mix node) before the voice adapter exists. */
  const prepareRecorder = useCallback(() => {
    const { consent, devices, sessionId, token } = optsRef.current;
    const config = configRef.current;
    if (recorderRef.current || !consent || !devices.micStream || !devices.audioContext) return;
    const wantAudio = config.recording.audio && consent.recordAudio;
    const wantVideo = config.recording.video && consent.recordVideo && !!devices.cameraStream;
    if (!wantAudio && !wantVideo) return;
    recorderRef.current = new CallRecorder(
      { sessionId, token, ctx: devices.audioContext, micStream: devices.micStream, cameraStream: devices.cameraStream, video: wantVideo },
      {
        onRecording: setRecording,
        onError: (m) => dispatch({ type: 'notice', level: 'warning', message: m }),
      },
    );
  }, []);

  /** Start recording once the session is live (the server refuses uploads before that). */
  const startRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec || rec.started || tornDown.current) return;
    await rec.start();
  }, []);

  // ── Teardown ──
  const teardown = useCallback(async () => {
    if (tornDown.current) return;
    tornDown.current = true;
    const conn = connRef.current;
    voiceUnsubs.current.forEach((u) => u());
    voiceRef.current?.stop();
    voiceRef.current = null;
    setAgentSpeaking(false);
    const rec = recorderRef.current;
    recorderRef.current = null;
    // Stop the recorder (flush + complete over REST) before closing the socket, so the server does not
    // consider the session abandoned while the last parts upload.
    await rec?.stop().catch(() => undefined);
    conn?.close();
  }, []);

  // ── Server messages ──
  const onServer = useCallback(
    (m: ServerMessage) => {
      dispatch({ type: 'server', msg: m });
      const vc = voiceRef.current;
      switch (m.type) {
        case 'welcome': {
          if (m.config) configRef.current = m.config;
          startedAtRef.current = Date.now() - (m.session.elapsedMs || 0);
          const prev = sessionState.current;
          sessionState.current = m.session.state;
          mutedRef.current = m.session.muted;
          setMutedState(m.session.muted);
          for (const t of m.transcript) spokenTurns.current.add(t.id);
          if (isTerminal(m.session.state)) {
            void teardown();
            return;
          }
          const needsStart = ['CREATED', 'READY', 'CONNECTING'].includes(m.session.state);
          if (!voiceRef.current) {
            // Set up audio before asking the server to start, so the greeting is spoken and its
            // playback events reach the server.
            // The server sends the realtime opening instruction itself (realtime.instruction).
            prepareRecorder();
            void buildVoice(false)
              .finally(() => {
                if (needsStart && !tornDown.current) send({ type: 'start' });
              });
          } else if (needsStart) send({ type: 'start' });
          if (prev !== m.session.state) lifecycle({ type: 'session.state', data: { state: m.session.state } });
          if (m.session.state === 'PAUSED') voiceRef.current?.setPaused(true);
          if (m.session.state === 'ACTIVE') void startRecording();
          break;
        }
        case 'state': {
          const prev = sessionState.current;
          sessionState.current = m.state;
          if (prev !== m.state) lifecycle({ type: 'session.state', data: { state: m.state, reason: m.reason } });
          if (m.state === 'ACTIVE') void startRecording();
          if (m.state === 'PAUSED') {
            vc?.setPaused(true);
            recorderRef.current?.pause();
          } else if (m.state === 'ACTIVE' && prev === 'PAUSED') {
            vc?.setPaused(false);
            recorderRef.current?.resume();
          }
          if (isTerminal(m.state)) void teardown();
          break;
        }
        case 'agent.start':
          chunkers.current.set(m.turnId, new SentenceChunker());
          break;
        case 'agent.delta': {
          if (!vc || spokenTurns.current.has(m.turnId) || vc.mode === 'realtime') break;
          let ch = chunkers.current.get(m.turnId);
          if (!ch) chunkers.current.set(m.turnId, (ch = new SentenceChunker()));
          for (const sentence of ch.push(m.text)) vc.speak(m.turnId, sentence);
          break;
        }
        case 'agent.end': {
          if (!vc || vc.mode === 'realtime' || spokenTurns.current.has(m.turnId)) break;
          spokenTurns.current.add(m.turnId);
          const ch = chunkers.current.get(m.turnId);
          chunkers.current.delete(m.turnId);
          const rest = ch ? ch.flush() : m.text;
          if (m.interrupted) break; // barge-in already stopped playback
          if (sessionState.current && !SPEAKABLE_STATES.includes(sessionState.current)) {
            vc.speak(m.turnId, '', { final: true });
            break;
          }
          vc.speak(m.turnId, rest, { final: true });
          break;
        }
        case 'agent.cancel':
          chunkers.current.delete(m.turnId);
          spokenTurns.current.add(m.turnId);
          vc?.cancelSpeech('server');
          break;
        case 'agent.audio':
          vc?.handleServerAudio?.(m);
          break;
        case 'turn.saved':
          spokenTurns.current.add(m.turn.id);
          break;
        case 'realtime.tool_result':
          vc?.sendToolResult?.(m.callId, m.output);
          break;
        case 'realtime.instruction':
          vc?.sendInstruction?.(m.text, m.respond);
          break;
        case 'end':
          lifecycle({ type: 'session.ended', data: { reason: m.reason, endedBy: m.endedBy } });
          // Let the goodbye finish playing (bounded) before releasing audio.
          setTimeout(() => void teardown(), vc?.speaks ? 200 : 0);
          break;
        case 'error':
          if (m.fatal) lifecycle({ type: 'error', data: { code: m.code, message: m.message } });
          break;
      }
    },
    [buildVoice, lifecycle, prepareRecorder, send, startRecording, teardown],
  );

  // ── Connection lifecycle ──
  useEffect(() => {
    tornDown.current = false;
    const conn = new SessionConnection({
      url: wsUrl('/ws/session'),
      sessionId: o.sessionId,
      token: o.token,
      clientInstanceId: clientInstanceId(),
    });
    connRef.current = conn;
    const offs = [
      conn.on('status', (s) => dispatch({ type: 'conn', status: s })),
      conn.on('message', onServer),
      conn.on('fatal', (kind: FatalKind, message: string) => {
        dispatch({ type: 'fatal', kind, message });
        if (kind === 'superseded') {
          // Another tab owns the call now: release mic/speech here but keep the ability to take over.
          voiceUnsubs.current.forEach((u) => u());
          voiceRef.current?.stop();
          voiceRef.current = null;
          setAgentSpeaking(false);
          const rec = recorderRef.current;
          recorderRef.current = null;
          void rec?.stop();
        } else if (kind === 'terminal') {
          lifecycle({ type: 'session.ended', data: { reason: message } });
          void teardown();
        } else {
          lifecycle({ type: 'error', data: { code: kind, message } });
          void teardown();
        }
      }),
    ];
    conn.connect();
    (window as any).__cfLive = { drop: () => conn.simulateDrop(), conn };
    const onUnload = () => {
      recorderRef.current?.stopOnUnload();
    };
    window.addEventListener('pagehide', onUnload);
    return () => {
      window.removeEventListener('pagehide', onUnload);
      offs.forEach((f) => f());
      void teardown();
      conn.close();
      delete (window as any).__cfLive;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.sessionId, o.token]);

  // ── Controls ──
  const setMuted = useCallback(
    (m: boolean) => {
      mutedRef.current = m;
      setMutedState(m);
      optsRef.current.devices.micStream?.getAudioTracks().forEach((t) => (t.enabled = !m));
      voiceRef.current?.setMuted(m);
      send({ type: 'control', action: m ? 'mute' : 'unmute' });
    },
    [send],
  );

  const pause = useCallback(() => {
    voiceRef.current?.setPaused(true);
    recorderRef.current?.pause();
    send({ type: 'control', action: 'pause' });
  }, [send]);

  const resume = useCallback(() => {
    voiceRef.current?.setPaused(false);
    recorderRef.current?.resume();
    send({ type: 'control', action: 'resume' });
  }, [send]);

  const end = useCallback(() => {
    setEnding(true);
    voiceRef.current?.commitNow();
    send({ type: 'control', action: 'end' });
  }, [send]);

  const sendTyped = useCallback(
    (text: string) => {
      const clean = text.trim().slice(0, 4000);
      if (!clean) return;
      const clientTurnId = randomId();
      const at = Math.max(0, Date.now() - startedAtRef.current);
      // Typing while the agent talks is an interruption too.
      if (configRef.current.turnTaking.allowBargeIn) voiceRef.current?.cancelSpeech('local');
      dispatch({ type: 'local.final', clientTurnId, text: clean });
      send({ type: 'participant.final', clientTurnId, text: clean, startedAtMs: at, endedAtMs: at, source: 'typed' });
    },
    [send],
  );

  const commitNow = useCallback(() => voiceRef.current?.commitNow(), []);

  const setPtt = useCallback((on: boolean) => {
    setPttState(on);
    pttRef.current = on;
    voiceRef.current?.setPushToTalk(on);
  }, []);

  const talk = useCallback((held: boolean) => {
    setTalkingState(held);
    voiceRef.current?.setTalking(held);
  }, []);

  const switchToTyping = useCallback(() => {
    unavailable.current.add('browser_stt');
    unavailable.current.add('server_stt');
    unavailable.current.add('realtime');
    void buildVoice(false);
  }, [buildVoice]);

  const takeOver = useCallback(() => {
    dispatch({ type: 'clearFatal' });
    connRef.current?.takeOver();
  }, []);

  const tool = useMemo(
    () => ({
      open: (toolId: string) => send({ type: 'tool.open', toolId }),
      respond: (toolCallId: string, result: Record<string, unknown>) => send({ type: 'tool.response', toolCallId, result }),
      update: (toolCallId: string, data: Record<string, unknown>) => {
        dispatch({ type: 'local.tool', toolCallId, data });
        send({ type: 'tool.update', toolCallId, data });
      },
    }),
    [send],
  );

  const subscribeLevel = useCallback((fn: (l: number) => void) => {
    levelSubs.current.add(fn);
    return () => void levelSubs.current.delete(fn);
  }, []);

  const controls = useMemo(
    () => ({ setMuted, pause, resume, end, sendTyped, commitNow, setPtt, talk, takeOver, switchToTyping }),
    [setMuted, pause, resume, end, sendTyped, commitNow, setPtt, talk, takeOver, switchToTyping],
  );

  return {
    state,
    dispatch,
    voiceMode,
    voicePlan,
    muted,
    ptt,
    talking,
    thinking,
    agentSpeaking,
    participantSpeaking,
    recording,
    ending,
    startedAt: () => startedAtRef.current,
    controls,
    tool,
    subscribeLevel,
    teardown,
  };
}

export function modeLabel(m: VoiceMode): string {
  return { browser: 'Browser speech', server: 'Server speech', realtime: 'OpenAI Realtime', typed: 'Typed' }[m];
}
