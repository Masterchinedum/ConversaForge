/**
 * Pure-logic tests for the live client (no browser needed): end-of-turn detection, VAD thresholds,
 * echo filter, sentence chunking, transcript dedupe, reconnect backoff, token/return-url handling,
 * bootstrap normalization, diagram layout and brand colors.
 */
import { expect, test } from '@playwright/test';
import type { ServerMessage, TurnDTO } from '@cf/shared';
import { brandStyle, formatClock, parseColor } from '../src/components/live/branding';
import { layoutDiagram } from '../src/components/live/tools/diagram-layout';
import { backoffDelay } from '../src/lib/live/connection';
import { normalizeBootstrap } from '../src/lib/live/runtime-api';
import { initialLiveState, liveReducer, transcriptRows, type LiveState } from '../src/lib/live/store';
import { isPlausibleSessionToken, safeReturnUrl } from '../src/lib/live/token';
import { EndOfTurnDetector, isLikelyIncomplete } from '../src/lib/voice/end-of-turn';
import { isLikelyEcho, SentenceChunker } from '../src/lib/voice/synth';
import { VadState } from '../src/lib/voice/vad';

/** Deterministic clock + timers for the detector. */
function fakeClock() {
  let now = 0;
  let timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.push({ at: now + ms, fn, id });
      return id;
    },
    clearTimer: (h: unknown) => {
      timers = timers.filter((t) => t.id !== h);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((t) => t !== due);
        now = due.at;
        due.fn();
      }
      now = end;
    },
  };
}

function detector(silenceMs = 1200, graceMs = 15000) {
  const clock = fakeClock();
  const commits: Array<{ text: string; reason: string; at: number }> = [];
  const thinking: boolean[] = [];
  const d = new EndOfTurnDetector(
    { silenceMs, graceMs, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer },
    { onCommit: (text, info) => commits.push({ text, reason: info.reason, at: clock.now() }), onThinking: (w) => thinking.push(w) },
  );
  return { d, clock, commits, thinking };
}

test.describe('end of turn', () => {
  test('incomplete utterance heuristics', () => {
    for (const t of ['um', 'So I think', 'We used Kafka because', 'and then, um', 'Let me think about that', 'Give me a second', 'It was like', 'Yes', 'I mean,', 'The thing is…'])
      expect(isLikelyIncomplete(t), t).toBe(true);
    for (const t of ['We shipped it in two weeks.', 'I led the migration to event sourcing', 'Let me think. We used a queue to decouple the writers from the readers.'])
      expect(isLikelyIncomplete(t), t).toBe(false);
  });

  test('complete sentence commits after the silence window, not before', () => {
    const { d, clock, commits } = detector();
    d.setInterim('We shipped it');
    clock.advance(400);
    d.addFinal('We shipped it in two weeks.');
    clock.advance(1100);
    expect(commits).toHaveLength(0);
    clock.advance(200);
    expect(commits).toEqual([{ text: 'We shipped it in two weeks.', reason: 'silence', at: 1600 }]);
  });

  test('thinking pause waits up to the grace period and is resumed by more speech', () => {
    const { d, clock, commits, thinking } = detector(1200, 10000);
    d.addFinal('So the first thing I would do is, um');
    clock.advance(1300);
    expect(commits).toHaveLength(0);
    expect(thinking).toEqual([true]);
    clock.advance(5000);
    expect(commits).toHaveLength(0);
    d.addFinal('add a cache.');
    expect(thinking).toEqual([true, false]);
    clock.advance(1300);
    expect(commits.map((c) => c.text)).toEqual(['So the first thing I would do is, um add a cache.']);
  });

  test('an unfinished thought is committed once the grace period elapses', () => {
    const { d, clock, commits } = detector(1200, 8000);
    d.addFinal('Because');
    clock.advance(7900);
    expect(commits).toHaveLength(0);
    clock.advance(200);
    expect(commits).toEqual([{ text: 'Because', reason: 'grace_elapsed', at: 8000 }]);
  });

  test('voice activity holds the commit; manual commit is immediate', () => {
    const { d, clock, commits } = detector();
    d.addFinal('We used Postgres.');
    d.setVoiceActive(true);
    clock.advance(5000);
    expect(commits).toHaveLength(0);
    d.setVoiceActive(false);
    clock.advance(1199);
    expect(commits).toHaveLength(0);
    clock.advance(1);
    expect(commits).toHaveLength(1);
    d.addFinal('Yes');
    d.commitNow();
    expect(commits[1]).toMatchObject({ text: 'Yes', reason: 'manual' });
    d.commitNow(); // nothing pending → no empty commit
    expect(commits).toHaveLength(2);
  });

  test('reset discards (echo) without committing', () => {
    const { d, clock, commits } = detector();
    d.addFinal('echo of the agent');
    d.reset();
    clock.advance(20000);
    expect(commits).toHaveLength(0);
  });
});

test('VAD: adaptive floor; barge-in needs sustained energy above a raised threshold', () => {
  const v = new VadState({ startMs: 150, bargeInMs: 300, hangoverMs: 450 });
  for (let i = 0; i < 100; i++) v.step(0.003, 30); // quiet room
  expect(v.speaking).toBe(false);
  // Normal speech starts after ~150 ms.
  let edge = null;
  for (let i = 0; i < 6 && !edge; i++) edge = v.step(0.08, 30);
  expect(edge).toBe('start');
  for (let i = 0; i < 20; i++) edge = v.step(0.002, 30) ?? edge;
  expect(v.speaking).toBe(false);
  // Agent playing: echo at moderate level must not trigger; a brief spike must not trigger.
  v.setAgentPlaying(true);
  for (let i = 0; i < 100; i++) expect(v.step(0.02, 30)).toBeNull();
  expect(v.step(0.3, 30)).toBeNull();
  for (let i = 0; i < 5; i++) v.step(0.02, 30);
  // Sustained loud speech (≥300 ms) is a barge-in.
  const edges: Array<string | null> = [];
  for (let i = 0; i < 12; i++) edges.push(v.step(0.3, 30));
  expect(edges.indexOf('start')).toBeGreaterThanOrEqual(9);
});

test('echo filter and sentence chunker', () => {
  const agent = 'Thanks for that. Could you walk me through a time you resolved a disagreement?';
  expect(isLikelyEcho('walk me through a time you resolved', agent)).toBe(true);
  expect(isLikelyEcho('sorry can I stop you there', agent)).toBe(false);
  const c = new SentenceChunker();
  expect(c.push('Hello there. How ')).toEqual(['Hello there.']);
  expect(c.push('are you? I am')).toEqual(['How are you?']);
  expect(c.flush()).toBe('I am');
});

const turn = (over: Partial<TurnDTO>): TurnDTO => ({
  id: 't',
  seq: 1,
  speaker: 'AGENT',
  text: '',
  clientTurnId: null,
  startedAtMs: null,
  endedAtMs: null,
  interrupted: false,
  source: null,
  ...over,
});
const apply = (s: LiveState, ...msgs: ServerMessage[]) => msgs.reduce((acc, msg) => liveReducer(acc, { type: 'server', msg }), s);

test('store: no duplicate transcript rows across streaming, optimistic sends, re-sends and resume', () => {
  let s = initialLiveState;
  s = apply(s, { type: 'agent.start', turnId: 'a1' }, { type: 'agent.delta', turnId: 'a1', text: 'Hi ' }, { type: 'agent.delta', turnId: 'a1', text: 'there' });
  expect(transcriptRows(s).map((r) => [r.text, r.status])).toEqual([['Hi there', 'streaming']]);
  s = apply(s, { type: 'agent.end', turnId: 'a1', text: 'Hi there.' }, { type: 'turn.saved', turn: turn({ id: 'a1', seq: 1, text: 'Hi there.' }) });
  s = liveReducer(s, { type: 'local.final', clientTurnId: 'c1', text: 'Hello' });
  s = liveReducer(s, { type: 'local.final', clientTurnId: 'c1', text: 'Hello' }); // resend
  expect(transcriptRows(s).map((r) => r.status)).toEqual(['saved', 'sending']);
  s = apply(s, { type: 'turn.saved', turn: turn({ id: 'p1', seq: 2, speaker: 'PARTICIPANT', text: 'Hello', clientTurnId: 'c1' }) });
  s = apply(s, { type: 'turn.saved', turn: turn({ id: 'p1', seq: 2, speaker: 'PARTICIPANT', text: 'Hello', clientTurnId: 'c1' }) });
  // Barge-in truncation re-sends the agent turn with new text: upsert, not append.
  s = apply(s, { type: 'turn.saved', turn: turn({ id: 'a1', seq: 1, text: 'Hi', interrupted: true }) });
  // Resume: welcome with overlapping transcript.
  s = apply(s, {
    type: 'welcome',
    protocol: 1,
    session: { id: 's', state: 'ACTIVE', scenarioName: 'x', startedAt: null, elapsedMs: 1000, maxDurationSec: 60, muted: false },
    config: {} as any,
    transcript: [turn({ id: 'p1', seq: 2, speaker: 'PARTICIPANT', text: 'Hello', clientTurnId: 'c1' }), turn({ id: 'a2', seq: 3, text: 'Next question?' })],
    tools: [],
    resumed: true,
  });
  expect(transcriptRows(s).map((r) => [r.speaker, r.text, r.status])).toEqual([
    ['AGENT', 'Hi', 'saved'],
    ['PARTICIPANT', 'Hello', 'saved'],
    ['AGENT', 'Next question?', 'saved'],
  ]);
  // Agent cancel drops the stream.
  s = apply(s, { type: 'agent.start', turnId: 'a3' }, { type: 'agent.delta', turnId: 'a3', text: 'x' }, { type: 'agent.cancel', turnId: 'a3' });
  expect(transcriptRows(s)).toHaveLength(3);
});

test('store: tools present/update/close', () => {
  let s = apply(initialLiveState, { type: 'tool.present', tool: { toolCallId: 'k', toolId: 'notepad', title: 'Notes', args: {} } });
  s = apply(s, { type: 'tool.update', toolCallId: 'k', data: { content: 'abc' } });
  expect(s.tools.k!.data).toEqual({ content: 'abc' });
  s = apply(s, { type: 'tool.close', toolCallId: 'k' });
  expect(s.tools.k!.closed).toBe(true);
});

test('reconnect backoff grows with jitter and is capped', () => {
  expect(backoffDelay(0, () => 0.5)).toBe(500);
  expect(backoffDelay(3, () => 0.5)).toBe(4000);
  expect(backoffDelay(20, () => 1)).toBeLessThanOrEqual(22500);
  expect(backoffDelay(2, () => 0)).toBe(1000);
});

test('return url and token validation', () => {
  expect(safeReturnUrl('/c/abc?x=1')).toBe('/c/abc?x=1');
  for (const bad of ['https://evil.com', '//evil.com', '/\\evil.com', 'javascript:alert(1)', '', null]) expect(safeReturnUrl(bad as any)).toBeNull();
  expect(isPlausibleSessionToken('cfs_abcdefghijklmnopqrstuvwxyz')).toBe(true);
  expect(isPlausibleSessionToken('cfe_abcdefghijklmnopqrstuvwxyz')).toBe(false);
});

test('bootstrap normalization (workstream B shape)', () => {
  const b = normalizeBootstrap(
    {
      session: { id: 's1', state: 'READY', maxDurationSec: 900 },
      scenario: { name: 'Interview', description: 'Desc', participantInstructions: 'Do X', targetDurationMinutes: 10 },
      consent: { required: true, given: true, recordAudio: true, recordVideo: false, analysis: true, retentionDays: 30, notice: 'N', recorded: { recordAudio: false, recordVideo: false, analysis: true, acceptedAt: 'now' } },
      report: { participantCanSeeFeedback: true },
      config: { persona: { name: 'Alex', role: 'r', avatar: { kind: 'initials' } }, branding: { displayName: 'Acme' } },
    },
    's1',
  );
  expect(b.scenario).toMatchObject({ name: 'Interview', publicDescription: 'Desc', estimatedMinutes: 10 });
  expect(b.consent.given).toMatchObject({ recordAudio: false, analysis: true });
  expect(b.participantCanSeeFeedback).toBe(true);
  expect(b.branding.displayName).toBe('Acme');
});

test('diagram layout and brand colors', () => {
  const l = layoutDiagram(
    [
      { id: 'a', label: 'LB' },
      { id: 'b', label: 'API' },
      { id: 'c', label: 'DB' },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' }, // cycle
      { from: 'a', to: 'zzz' }, // dangling
    ],
  );
  expect(l.pos.get('a')!.x).toBeLessThan(l.pos.get('b')!.x);
  expect(l.pos.get('b')!.x).toBeLessThan(l.pos.get('c')!.x);
  expect(l.edges).toHaveLength(3);
  expect(parseColor('#abc')).toEqual([170, 187, 204]);
  expect(parseColor('nope')).toBeNull();
  const style = brandStyle('#ffff00') as Record<string, string>;
  // Very light brand colors are darkened for readable white-on-brand text.
  const [r, g] = style['--brand-600']!.split(' ').map(Number);
  expect(r! + g!).toBeLessThan(400);
  expect(formatClock(65_000)).toBe('1:05');
  expect(formatClock(3_725_000)).toBe('1:02:05');
});
