import type { TurnRecord } from './history';
import { keywords, simulateAgentTurn } from './simulator-agent';
import { initialRuntimeState, type RuntimeState } from '../runtime.types';
import { interviewConfig } from '../testing/fixtures';

let seq = 0;
const t = (speaker: TurnRecord['speaker'], text: string): TurnRecord => ({
  id: `t${++seq}`,
  seq,
  speaker,
  text,
  interrupted: false,
  clientTurnId: null,
  startedAtMs: null,
  endedAtMs: null,
  source: null,
  metadata: {},
});

describe('simulator agent', () => {
  const config = interviewConfig();
  const vars = { participant_name: 'Jane' };

  function step(state: RuntimeState, turns: TurnRecord[], said: string) {
    turns.push(t('PARTICIPANT', said));
    const out = simulateAgentTurn({ config, variables: vars, state, turns, trigger: { kind: 'participant_turn' }, endSessionEnabled: true });
    turns.push(t('AGENT', out.text));
    const progress = out.toolCalls.find((c) => c.name === 'update_progress')!.input as any;
    const next: RuntimeState = {
      ...state,
      sim: out.sim,
      coveredTopicIds: [...new Set([...state.coveredTopicIds, ...progress.coveredTopicIds])],
      currentTopicId: progress.currentTopicId,
    };
    return { out, state: next };
  }

  it('walks the agenda, follows up on vague answers using key words, respects maxFollowUps and ends', () => {
    let state = initialRuntimeState();
    const turns: TurnRecord[] = [t('AGENT', 'Hi Jane, I am Alex. Ready to begin?')];
    let r = step(state, turns, "Yes, I'm ready");
    expect(r.out.text).toMatch(/recent backend work/i);
    state = r.state;

    r = step(state, turns, 'I worked on payments stuff.');
    expect(r.out.text).toMatch(/payments/i); // follow-up references the answer
    expect(r.out.text).toMatch(/\?$/);
    state = r.state;

    r = step(state, turns, 'Kafka things mostly.');
    expect(r.out.text).toMatch(/kafka/i); // second follow-up allowed (maxFollowUps 2)
    state = r.state;

    r = step(state, turns, 'Some more things.');
    // follow-ups exhausted → moves on to next topic
    expect(r.out.text).toMatch(/scaling a system under load/i);
    expect(r.state.coveredTopicIds).toContain('background');
    state = r.state;

    r = step(state, turns, 'Can you repeat that?');
    expect(r.out.text).toMatch(/^Of course\. Could you walk me through your experience with scaling/);
    state = r.state;

    r = step(
      state,
      turns,
      'During Black Friday our checkout API went from two thousand to twenty thousand requests per second and we added caching and load shedding.',
    );
    expect(r.out.text).toMatch(/anything you would like to add/i);
    expect(r.out.text).toContain('Black Friday');
    expect(r.out.text).not.toContain('During Black Friday');
    state = r.state;

    r = step(state, turns, 'No, nothing else.');
    expect(r.out.text).toContain('Thanks Jane, goodbye!');
    expect(r.out.toolCalls.map((c) => c.name)).toEqual(['update_progress', 'end_session']);
    expect(r.out.toolCalls[1]!.input).toEqual({ reason: 'completed' });
  });

  it('handles stop requests, "a moment" and silence check-ins', () => {
    const state = initialRuntimeState();
    const turns: TurnRecord[] = [t('AGENT', 'Hi')];
    let r = step(state, turns, 'Give me a moment please');
    expect(r.out.text).toMatch(/take your time/i);
    const check = simulateAgentTurn({ config, variables: vars, state: r.state, turns, trigger: { kind: 'silence_check_in', silentMs: 25000 }, endSessionEnabled: true });
    expect(check.text).toMatch(/no rush/i);
    r = step(r.state, turns, 'Actually I need to stop the interview now');
    expect(r.out.toolCalls.find((c) => c.name === 'end_session')?.input).toEqual({ reason: 'participant_request' });
  });

  it('offers a simpler angle once on "I don\'t know", then moves on', () => {
    let state = { ...initialRuntimeState(), sim: { topicIndex: 0, followUps: 0, lastQuestion: 'Q', closingAsked: false, waitingForMoment: false } };
    const turns: TurnRecord[] = [t('AGENT', 'Q')];
    let r = step(state, turns, "I don't know");
    expect(r.out.text).toMatch(/even a small or recent example/);
    state = r.state;
    r = step(state, turns, "I'm not sure, no idea");
    expect(r.out.text).toMatch(/move on/);
  });

  it('extracts salient keywords', () => {
    expect(keywords('I led the Kubernetes migration at Acme Corp', 2)).toEqual(['Kubernetes', 'Acme Corp']);
    expect(keywords('we refactored the billing pipeline', 1)).toEqual(['refactored']);
  });
});
