'use client';
import { Button, clsx, Modal, SimulatedBadge } from '@/components/ui';
import type { LiveBootstrap } from '@/lib/live/runtime-api';
import { transcriptRows } from '@/lib/live/store';
import { modeLabel, useLiveCall, type CallDevices, type LifecycleEvent } from '@/lib/live/use-live-call';
import { isTerminal, type SessionState } from '@cf/shared';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { AgentAvatar } from './AgentAvatar';
import { formatClock } from './branding';
import { MicMeter } from './MicMeter';
import { Transcript } from './Transcript';
import { ToolPanel } from './tools/ToolPanel';

export interface CallEnded {
  state: SessionState | null;
  reason: string | null;
  endedBy?: string | null;
  elapsedMs: number;
  fatal?: { kind: string; message: string } | null;
}

export function CallScreen({
  boot,
  token,
  devices,
  consent,
  compact,
  onEnded,
  onLifecycle,
}: {
  boot: LiveBootstrap;
  token: string;
  devices: CallDevices;
  consent: { recordAudio: boolean; recordVideo: boolean; analysis: boolean } | null;
  compact?: boolean;
  onEnded: (e: CallEnded) => void;
  onLifecycle?: (e: LifecycleEvent) => void;
}) {
  const { config } = boot;
  const call = useLiveCall({ sessionId: boot.sessionId, token, config, devices, consent, onLifecycle });
  const { state, controls } = call;
  const [confirmEnd, setConfirmEnd] = useState(false);
  const [typed, setTyped] = useState('');
  const [now, setNow] = useState(Date.now());
  const endedRef = useRef(false);
  const rows = useMemo(() => transcriptRows(state), [state]);
  const tools = useMemo(() => state.toolOrder.map((id) => state.tools[id]!).filter(Boolean), [state.toolOrder, state.tools]);
  const sState = state.state;
  const live = sState === 'ACTIVE';
  const paused = sState === 'PAUSED';
  const connOk = state.conn === 'open' && state.welcomed;
  const listens = call.voiceMode !== null && call.voiceMode !== 'typed';
  const agentName = config.persona.name || 'Agent';

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);

  const tick = state.timer && live && connOk ? now - state.timer.at : 0;
  const elapsedMs = (state.timer?.elapsedMs ?? 0) + tick;
  const remainingMs = Math.max(0, (state.timer?.remainingMs ?? (boot.maxDurationSec ?? 0) * 1000) - tick);

  // Hand over to the end screen.
  useEffect(() => {
    if (endedRef.current) return;
    const terminal = (sState && isTerminal(sState)) || state.end || state.fatal?.kind === 'terminal';
    const fatal = state.fatal && ['auth', 'protocol', 'gave_up'].includes(state.fatal.kind) ? state.fatal : null;
    if (!terminal && !fatal) return;
    endedRef.current = true;
    const delay = call.agentSpeaking ? 1500 : 400;
    const t = setTimeout(
      () =>
        onEnded({
          state: sState,
          reason: state.end?.reason ?? state.stateReason ?? state.fatal?.message ?? null,
          endedBy: state.end?.endedBy ?? null,
          elapsedMs,
          fatal,
        }),
      delay,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sState, state.end, state.fatal]);

  // Host page commands (embed SDK `end()`).
  useEffect(() => {
    const onCmd = (e: Event) => {
      if ((e as CustomEvent).detail?.type === 'end') controls.end();
    };
    window.addEventListener('cf-live-command', onCmd);
    return () => window.removeEventListener('cf-live-command', onCmd);
  }, [controls]);

  // Push-to-talk: hold Space anywhere except in text fields.
  useEffect(() => {
    if (!call.ptt || !listens) return;
    const isField = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || e.repeat || isField(e.target)) return;
      if (e.target instanceof HTMLButtonElement && !e.target.dataset.ptt) return;
      e.preventDefault();
      controls.talk(true);
    };
    const up = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || isField(e.target)) return;
      if (e.target instanceof HTMLButtonElement && !e.target.dataset.ptt) return;
      e.preventDefault();
      controls.talk(false);
    };
    const blur = () => controls.talk(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, [call.ptt, listens, controls]);

  const status = (() => {
    if (state.fatal?.kind === 'superseded') return { label: 'Open in another tab', tone: 'gray' as const };
    if (sState && isTerminal(sState)) return { label: 'Ended', tone: 'gray' as const };
    if (state.conn === 'offline') return { label: 'Offline — reconnecting…', tone: 'yellow' as const };
    if (state.conn === 'reconnecting' || (state.conn === 'connecting' && state.turns.length > 0)) return { label: 'Reconnecting…', tone: 'yellow' as const };
    if (!connOk) return { label: 'Connecting…', tone: 'yellow' as const };
    if (sState === 'ENDING' || call.ending) return { label: 'Ending…', tone: 'gray' as const };
    if (paused) return { label: 'Paused', tone: 'blue' as const };
    if (sState === 'RECONNECTING') return { label: 'Reconnecting…', tone: 'yellow' as const };
    if (live) return { label: 'Live', tone: 'green' as const };
    return { label: 'Connecting…', tone: 'yellow' as const };
  })();

  const activity = (() => {
    if (paused) return 'Paused';
    if (call.agentSpeaking) return `${agentName} is speaking…`;
    if (call.muted && listens) return 'You are muted';
    if (call.thinking) return 'Listening… take your time';
    if (call.participantSpeaking) return 'Listening…';
    if (call.ptt && listens) return 'Hold Space or the talk button to speak';
    if (listens && live) return 'Your turn — speak when ready';
    if (live) return 'Type your reply below';
    return '';
  })();

  const submitTyped = (e: FormEvent) => {
    e.preventDefault();
    if (!typed.trim()) return;
    controls.sendTyped(typed);
    setTyped('');
  };

  const pillTone = {
    green: 'bg-emerald-100 text-emerald-800',
    yellow: 'bg-amber-100 text-amber-900',
    blue: 'bg-sky-100 text-sky-800',
    gray: 'bg-slate-100 text-slate-700',
  }[status.tone];

  const showTyping = config.ui.allowTextFallback || call.voiceMode === 'typed';
  const inputDisabled = !live || !connOk;
  const toolsPanel =
    config.ui.showArtifactPanel && (tools.some((t) => !t.closed) || config.participantTools.length > 0) ? (
      <ToolPanel
        tools={tools}
        participantTools={config.participantTools}
        sessionId={boot.sessionId}
        token={token}
        onOpen={call.tool.open}
        onRespond={call.tool.respond}
        onUpdate={call.tool.update}
        disabled={inputDisabled}
      />
    ) : null;

  return (
    <div className={clsx('flex flex-col', compact ? 'gap-3' : 'gap-4')}>
      {/* ── Status bar ── */}
      <div className="flex flex-wrap items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-sm ring-1 ring-slate-200">
        <span className={clsx('inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold', pillTone)} data-testid="call-status">
          {status.tone === 'green' && <span className="h-2 w-2 rounded-full bg-emerald-500" aria-hidden />}
          {status.label}
        </span>
        {call.recording && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-2.5 py-1 text-xs font-semibold text-red-700" data-testid="recording-indicator">
            <span className="h-2 w-2 rounded-full bg-red-600 motion-safe:animate-pulse" aria-hidden />
            Recording
          </span>
        )}
        {config.simulated && <SimulatedBadge what="Simulated agent" />}
        <span className="ml-auto flex items-center gap-3 text-xs tabular-nums text-slate-600">
          <span title="Elapsed">
            <span className="sr-only">Elapsed </span>
            {formatClock(elapsedMs)}
          </span>
          {(state.timer || boot.maxDurationSec) && (
            <span title="Remaining" className={clsx(remainingMs < 60000 && 'font-semibold text-red-700')}>
              {formatClock(remainingMs)} left
            </span>
          )}
          {call.voiceMode && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-700" data-testid="voice-mode">
              Voice: {modeLabel(call.voiceMode)}
            </span>
          )}
        </span>
      </div>
      <p className="sr-only" aria-live="assertive">
        {status.label === 'Live' ? 'Call is live' : status.label}
        {call.recording ? '. Recording.' : ''}
      </p>

      {/* ── Notices ── */}
      {state.notices.length > 0 && (
        <ul className="space-y-1" aria-live="polite">
          {state.notices.map((n) => (
            <li
              key={n.id}
              className={clsx(
                'flex items-start justify-between gap-2 rounded-md border px-3 py-2 text-sm',
                n.level === 'info' ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-amber-200 bg-amber-50 text-amber-900',
              )}
            >
              <span>{n.message}</span>
              <button
                className="rounded px-1 text-xs opacity-70 hover:opacity-100 focus-visible:ring-2 focus-visible:ring-brand-500"
                onClick={() => call.dispatch({ type: 'dismissNotice', id: n.id })}
                aria-label="Dismiss notice"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {state.fatal?.kind === 'superseded' && (
        <div className="rounded-lg border border-slate-300 bg-white p-4 text-sm shadow-sm" role="alert">
          <p className="font-medium text-slate-900">This session was opened in another tab or device.</p>
          <p className="mt-1 text-slate-600">Only one window can be connected at a time.</p>
          <Button className="mt-3" onClick={controls.takeOver}>
            Continue here instead
          </Button>
        </div>
      )}

      <div className={clsx('grid gap-4', toolsPanel && !compact && 'lg:grid-cols-[minmax(0,1fr)_380px]')}>
        {/* ── Conversation column ── */}
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-4 rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200">
            <AgentAvatar persona={config.persona} speaking={call.agentSpeaking} size={compact ? 'md' : 'lg'} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-base font-semibold text-slate-900">{agentName}</p>
              {config.persona.role && <p className="truncate text-sm text-slate-600">{config.persona.role}</p>}
              <p className={clsx('mt-1 text-sm', call.thinking ? 'text-brand-700' : 'text-slate-600')} aria-live="polite" data-testid="activity">
                {activity}
              </p>
              {listens && <MicMeter subscribe={call.subscribeLevel} muted={call.muted || paused} className="mt-2 max-w-xs" />}
            </div>
          </div>

          {config.ui.showCaptions && <Transcript rows={rows} agentName={agentName} compact={compact} />}

          {paused && (
            <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm text-sky-900" role="status">
              The conversation is paused. The agent won’t speak or listen until you resume.
            </div>
          )}

          {/* ── Typed input ── */}
          {showTyping && (
            <form onSubmit={submitTyped} className="flex gap-2">
              <label htmlFor="cf-typed" className="sr-only">
                Type a message
              </label>
              <input
                id="cf-typed"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                maxLength={4000}
                disabled={inputDisabled}
                autoComplete="off"
                placeholder={call.voiceMode === 'typed' ? 'Type your reply…' : 'Or type a message…'}
                className="block w-full min-w-0 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500 disabled:bg-slate-100"
                data-testid="typed-input"
              />
              <Button type="submit" disabled={inputDisabled || !typed.trim()}>
                Send
              </Button>
            </form>
          )}

          {/* ── Controls ── */}
          <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Call controls">
            {listens && (
              <Button
                variant={call.muted ? 'danger' : 'secondary'}
                aria-pressed={call.muted}
                onClick={() => controls.setMuted(!call.muted)}
                disabled={!connOk || !(live || paused)}
              >
                {call.muted ? '🔇 Unmute' : '🎙 Mute'}
              </Button>
            )}
            <Button
              variant="secondary"
              onClick={paused ? controls.resume : controls.pause}
              disabled={!connOk || !(live || paused)}
              aria-pressed={paused}
            >
              {paused ? '▶ Resume' : '⏸ Pause'}
            </Button>
            {listens && call.ptt && (
              <button
                type="button"
                data-ptt="1"
                onPointerDown={(e) => {
                  e.currentTarget.setPointerCapture(e.pointerId);
                  controls.talk(true);
                }}
                onPointerUp={() => controls.talk(false)}
                onPointerCancel={() => controls.talk(false)}
                onKeyDown={(e) => {
                  if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
                    e.preventDefault();
                    controls.talk(true);
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === ' ' || e.key === 'Enter') {
                    e.preventDefault();
                    controls.talk(false);
                  }
                }}
                disabled={!live || call.muted}
                aria-pressed={call.talking}
                className={clsx(
                  'select-none rounded-md px-4 py-2 text-sm font-semibold text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50',
                  call.talking ? 'bg-emerald-600' : 'bg-brand-600 hover:bg-brand-700',
                )}
              >
                {call.talking ? 'Listening… release to send' : 'Hold to talk'}
              </button>
            )}
            {listens && !call.ptt && (
              <Button variant="secondary" onClick={controls.commitNow} disabled={!live} title="Send what you said now instead of waiting">
                ✓ I’m done answering
              </Button>
            )}
            {listens && (
              <label className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-slate-700">
                <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" checked={call.ptt} onChange={(e) => controls.setPtt(e.target.checked)} />
                Push to talk
              </label>
            )}
            {listens && config.ui.allowTextFallback && (
              <Button variant="ghost" size="sm" onClick={controls.switchToTyping}>
                Switch to typing
              </Button>
            )}
            <span className="flex-1" />
            {config.allowParticipantEnd && (
              <Button variant="danger" onClick={() => setConfirmEnd(true)} disabled={!connOk || call.ending || !(live || paused)} data-testid="end-call">
                End call
              </Button>
            )}
          </div>
          {call.recording && call.voicePlan?.output === 'browser' && (
            <p className="text-xs text-slate-500">Note: in browser speech mode, the recording contains your voice only; the agent’s words are in the transcript.</p>
          )}
        </div>

        {/* ── Artifact panel ── */}
        {toolsPanel && <aside className="min-w-0">{toolsPanel}</aside>}
      </div>

      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="End the conversation?"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmEnd(false)} autoFocus>
              Keep talking
            </Button>
            <Button
              variant="danger"
              data-testid="confirm-end"
              onClick={() => {
                setConfirmEnd(false);
                controls.end();
              }}
            >
              End call
            </Button>
          </>
        }
      >
        <p className="text-sm text-slate-700">You won’t be able to continue this session after ending it.</p>
      </Modal>
    </div>
  );
}
