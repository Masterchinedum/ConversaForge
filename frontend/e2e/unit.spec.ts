/**
 * Pure-logic tests for the live client (no browser needed): end-of-turn detection, VAD thresholds,
 * echo filter, sentence chunking, transcript dedupe, reconnect backoff, token/return-url handling,
 * bootstrap normalization, diagram layout and brand colors.
 */
import { expect, test } from '@playwright/test';
import type { ServerMessage, TurnDTO } from '@/shared';
import { brandStyle, formatClock, parseColor } from '../src/components/live/branding';
import { layoutDiagram } from '../src/components/live/tools/diagram-layout';
import { backoffDelay } from '../src/lib/live/connection';
import { normalizeBootstrap } from '../src/lib/live/runtime-api';
import { initialLiveState, liveReducer, transcriptRows, turnMatchesItem, type LiveState } from '../src/lib/live/store';
import { isPlausibleSessionToken, safeReturnUrl } from '../src/lib/live/token';
import { EndOfTurnDetector, isLikelyIncomplete } from '../src/lib/voice/end-of-turn';
import { isLikelyEcho, SentenceChunker } from '../src/lib/voice/synth';
import { VadState } from '../src/lib/voice/vad';
import { planVoice, unavailableKeyFor, voiceLabel } from '../src/lib/voice';
import { cleanTranscript, floatToPcm16Base64, heardText } from '../src/lib/voice/gemini-live';
import { Resampler } from '../src/lib/voice/audio-player';

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

test('VAD: aboveMs reports a start-of-speech building up and resets after silence', () => {
  const v = new VadState({ startMs: 150, bargeInMs: 300, hangoverMs: 450 });
  for (let i = 0; i < 50; i++) v.step(0.003, 30);
  expect(v.aboveMs).toBe(0);
  v.setAgentPlaying(true);
  for (let i = 0; i < 14; i++) v.step(0.003, 30); // past the echo warm-up
  v.step(0.3, 30);
  v.step(0.3, 30);
  expect(v.aboveMs).toBe(60);
  for (let i = 0; i < 4; i++) v.step(0.002, 30);
  expect(v.aboveMs).toBe(0);
});

test('VAD: the echo of the agent\'s first words is learned, not mistaken for a barge-in', () => {
  const v = new VadState({ startMs: 150, bargeInMs: 300, hangoverMs: 450, agentWarmupMs: 400 });
  for (let i = 0; i < 100; i++) v.step(0.003, 30); // quiet room: threshold ≈ 0.012
  v.setAgentPlaying(true);
  // Loud speaker echo (no echo cancellation) from the very first tick: never a start-of-speech.
  const edges: Array<string | null> = [];
  for (let i = 0; i < 60; i++) edges.push(v.step(0.06 + (i % 3) * 0.02, 30)); // 1.8 s of bursty echo
  expect(edges.every((e) => e === null)).toBe(true);
  expect(v.threshold()).toBeGreaterThan(0.2); // learned floor × echoRatio
  // The participant talking clearly over it (louder than the echo, sustained) still barges in.
  let start = -1;
  for (let i = 0; i < 20 && start < 0; i++) if (v.step(0.5, 30) === 'start') start = i;
  expect(start).toBeGreaterThanOrEqual(9);
});

test('transcript cleaning: placeholder tokens and punctuation-only fragments are not speech', () => {
  expect(cleanTranscript('<no speech>{pause}')).toBe('');
  expect(cleanTranscript('...')).toBe('');
  expect(cleanTranscript('…')).toBe('');
  expect(cleanTranscript(' <noise> Hi Casey, good to see you. ')).toBe('Hi Casey, good to see you.');
  expect(cleanTranscript('It sounds like {pause} a lot of pressure')).toBe('It sounds like a lot of pressure');
  expect(cleanTranscript('Numbers like 3 count')).toBe('Numbers like 3 count');
  expect(cleanTranscript('...d...')).toBe('...d...');
  // Tokens arriving in pieces stay hidden until complete.
  expect(cleanTranscript('<no')).toBe('');
  expect(cleanTranscript('Sure. <no')).toBe('Sure.');
  expect(cleanTranscript('<no speech>{pau')).toBe('');
});

test('resampler: continuous across chunk boundaries, exact 2× upsampling, keeps sample count over time', () => {
  // 24 kHz → 48 kHz: each input sample yields two output samples; chunk seams interpolate against the
  // previous chunk's last sample instead of restarting from zero.
  const r = new Resampler(24000, 48000);
  const a = r.process(new Float32Array([0, 1, 0, -1]));
  expect([...a]).toEqual([0, 0.5, 1, 0.5, 0, -0.5, -1]);
  const b = r.process(new Float32Array([0, 1]));
  expect([...b]).toEqual([-0.5, 0, 0.5, 1]); // starts halfway between -1 (previous chunk) and 0
  // 24 kHz → 44.1 kHz over many chunks: output count tracks the ratio (no drift, no gaps).
  const r2 = new Resampler(24000, 44100);
  let total = 0;
  for (let i = 0; i < 100; i++) total += r2.process(new Float32Array(2400).fill(0.1)).length;
  expect(Math.abs(total - (240000 * 44100) / 24000)).toBeLessThan(3);
  // Same rate: pass-through.
  const same = new Float32Array([0.25, 0.5]);
  expect(new Resampler(48000, 48000).process(same)).toBe(same);
});

test('store: live-model rows are not duplicated (server saves them as rt_<itemId>) and captions clear', () => {
  let s = initialLiveState;
  s = liveReducer(s, { type: 'local.partial', clientTurnId: 'g1_1_u', text: 'Hello from' });
  s = liveReducer(s, { type: 'local.realtimeDelta', itemId: 'g1_1_u', role: 'user', text: 'Hello from' });
  // While the participant is still being transcribed the utterance shows once, as the caption.
  expect(transcriptRows(s).map((r) => [r.text, r.status])).toEqual([['Hello from', 'partial']]);
  s = liveReducer(s, { type: 'local.partial', clientTurnId: 'g1_1_u', text: '' });
  expect(transcriptRows(s).map((r) => [r.text, r.status])).toEqual([['Hello from', 'streaming']]);
  s = liveReducer(s, { type: 'local.realtimeDelta', itemId: 'g1_2_a', role: 'assistant', text: 'Hi there.' });
  expect(transcriptRows(s)).toHaveLength(2);
  expect(turnMatchesItem({ id: 't1', clientTurnId: 'rt_g1_1_u' }, 'g1_1_u')).toBe(true);
  expect(turnMatchesItem({ id: 't1', clientTurnId: 'rt_g1_1_u' }, 'g1_2_a')).toBe(false);
  s = apply(s, { type: 'turn.saved', turn: turn({ id: 't1', seq: 1, speaker: 'PARTICIPANT', text: 'Hello from Gemini.', clientTurnId: 'rt_g1_1_u' }) });
  s = apply(s, { type: 'turn.saved', turn: turn({ id: 't2', seq: 2, speaker: 'AGENT', text: 'Hi there.', clientTurnId: 'rt_g1_2_a' }) });
  expect(transcriptRows(s).map((r) => [r.text, r.status])).toEqual([
    ['Hello from Gemini.', 'saved'],
    ['Hi there.', 'saved'],
  ]);
  // Late deltas for a saved item are ignored; a resumed welcome drops in-flight rows the server already has.
  s = liveReducer(s, { type: 'local.realtimeDelta', itemId: 'g1_2_a', role: 'assistant', text: 'Hi there. More' });
  expect(transcriptRows(s)).toHaveLength(2);
  s = liveReducer(s, { type: 'local.realtimeDelta', itemId: 'g1_3_a', role: 'assistant', text: 'Next' });
  s = apply(s, {
    type: 'welcome',
    protocol: 1,
    session: { id: 's', state: 'ACTIVE', elapsedMs: 0, maxDurationSec: 600, muted: false } as any,
    config: undefined as any,
    transcript: [turn({ id: 't3', seq: 3, speaker: 'AGENT', text: 'Next question.', clientTurnId: 'rt_g1_3_a' })],
    tools: [],
    resumed: true,
  } as any);
  expect(transcriptRows(s).map((r) => r.text)).toEqual(['Hello from Gemini.', 'Hi there.', 'Next question.']);
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

test('live voice plan: provider-specific capability checks, labels, heard-text truncation', () => {
  const caps = { secureContext: true, getUserMedia: true, speechRecognition: true, speechSynthesis: true, mediaRecorder: true, webrtc: false, audioContext: true, websocket: true };
  const base: any = { voiceMode: 'realtime', stt: 'browser', tts: 'browser', turnTaking: {} };
  // Gemini Live needs WebAudio + WebSocket (not WebRTC); OpenAI Realtime needs WebRTC.
  expect(planVoice({ ...base, realtime: { provider: 'google', model: 'g' } }, caps, { hasMic: true }).mode).toBe('realtime');
  const oa = planVoice({ ...base, realtime: { provider: 'openai', model: 'o' } }, caps, { hasMic: true });
  expect(oa.mode).toBe('browser');
  expect(oa.reason).toMatch(/WebRTC/);
  const failed = planVoice({ ...base, realtime: { provider: 'google', model: 'g' } }, caps, { hasMic: true, unavailable: new Set(['realtime']) });
  expect(failed).toMatchObject({ mode: 'browser', reason: 'Live voice is unavailable right now.' });
  // Gemini Live first, then the OpenAI backup, then browser speech.
  const all = { ...caps, webrtc: true };
  const withBackup = { ...base, realtime: { provider: 'google', model: 'g', backup: { provider: 'openai', model: 'o' } } };
  expect(planVoice(withBackup, all, { hasMic: true })).toMatchObject({ mode: 'realtime', realtimeProvider: 'google' });
  expect(planVoice(withBackup, all, { hasMic: true, unavailable: new Set(['realtime:google']) })).toMatchObject({ mode: 'realtime', realtimeProvider: 'openai' });
  expect(planVoice(withBackup, all, { hasMic: true, unavailable: new Set(['realtime:google', 'realtime:openai']) })).toMatchObject({
    mode: 'browser',
    reason: 'Live voice is unavailable right now.',
  });
  expect(unavailableKeyFor('realtime', 'provider_unavailable', 'google')).toEqual(['realtime:google']);
  expect(voiceLabel('realtime', { realtime: { provider: 'google', model: 'g' } }, 'openai')).toBe('OpenAI Realtime');
  expect(voiceLabel('realtime', { realtime: { provider: 'google', model: 'g' } })).toBe('Google Gemini Live');
  expect(voiceLabel('realtime', { realtime: { provider: 'openai', model: 'o' } })).toBe('OpenAI Realtime');
  expect(voiceLabel('browser', null)).toBe('Browser speech');
  expect(heardText('Hi, I am the agent today.', 12)).toBe('Hi, I am');
  expect(heardText('Short.', 100)).toBe('Short.');
  expect(Buffer.from(floatToPcm16Base64(new Float32Array([0, 1, -1, 0.5])), 'base64')).toEqual(Buffer.from([0, 0, 0xff, 0x7f, 0x00, 0x80, 0xff, 0x3f]));
});
