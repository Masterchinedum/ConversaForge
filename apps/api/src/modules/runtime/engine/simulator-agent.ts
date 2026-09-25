import { substituteVariables, type AgendaItem, type ScenarioConfig } from '@cf/shared';
import type { RuntimeState, SimulatorState } from '../runtime.types';
import type { GenerationTrigger, TurnRecord } from './history';
import { closingText, effectiveAgenda } from './prompt-compiler';

/**
 * LOCAL DEVELOPMENT SIMULATOR — a deterministic, rule-based conversational agent used when no LLM
 * provider is configured. It is not a language model, but it genuinely reacts to what the participant
 * says: it walks the agenda in order, forms follow-ups from key words in short/vague answers, respects
 * maxFollowUps, handles "repeat that" / "I don't know" / "give me a moment" / "stop", runs the closing
 * exchange and calls end_session. It emits update_progress so topic tracking works like a real model.
 * Everything it produces is labeled simulated.
 */

export interface SimulatorOutput {
  text: string;
  toolCalls: Array<{ name: string; input: Record<string, unknown> }>;
  sim: SimulatorState;
}

const STOPWORDS = new Set(
  (
    'a an and are as at be been but by can could did do does doing done for from had has have having he her here hers him his how i if in into is it its just like me more most my no not of on once only or other our out over own really same she should so some such than that the their them then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yeah yes okay ok um uh hmm well actually basically kind sort maybe probably lot lots thing things stuff something anything everything think thought know knew mean guess pretty much also about because going gonna got get getting make made really very much many been being say said im its dont didnt thats ive id youre theyre weve worked work working time times one two first last new good great different able year years month months week weeks day days people team role job company project projects'
  ).split(' '),
);

const VAGUE_RE = /\b(stuff|things|kind of|sort of|i guess|it depends|whatever|etc|and so on|you know)\b/i;
const STOP_RE =
  /\b(stop (the|this) (call|session|interview|conversation)|end (the|this) (call|session|interview|conversation)|i (have|need|want) to (go|leave|stop)|let'?s (stop|end)( here| now)?|can we (stop|end)|i'?m done( here)?|hang up|quit)\b/i;
const REPEAT_RE = /\b(repeat|say (that|it) again|come again|pardon|didn'?t (catch|hear|understand)|rephrase|what was the question)\b/i;
const MOMENT_RE = /\b(a moment|a second|a sec|a minute|let me think|give me (a|one) (moment|second|minute|sec)|hold on|one moment|thinking)\b/i;
const DONT_KNOW_RE = /\b(i don'?t know|i'?m not sure|no idea|not sure|can'?t remember|don'?t remember|no experience|never (done|had) (that|this))\b/i;
const READY_RE = /\b(ready|go ahead|let'?s (go|start|begin)|sure|yes|yep|sounds good|ok(ay)?|hi|hello|hey)\b/i;

export function keywords(text: string, max = 2): string[] {
  const out: string[] = [];
  // Prefer multi-word capitalized phrases (names of products, companies, technologies).
  const caps = text.match(/\b([A-Z][a-zA-Z0-9+#.-]*(?:\s+[A-Z][a-zA-Z0-9+#.-]*)*)\b/g) ?? [];
  for (const c of caps) {
    const parts = c.trim().split(/\s+/);
    while (parts.length && (SENTENCE_STARTERS.has(parts[0]!.toLowerCase()) || STOPWORDS.has(parts[0]!.toLowerCase()))) parts.shift();
    const w = parts.join(' ');
    if (w.length > 2 && !STOPWORDS.has(w.toLowerCase()) && !/^(I|I'm|I've|We|The|It|So|And|But|My|Our|Yes|No|Well|Then|That)$/.test(w)) {
      if (!out.includes(w)) out.push(w);
    }
    if (out.length >= max) return out;
  }
  // Then runs of up to three content words (skipping verb/adverb-looking words), longest first.
  const tokens = text
    .replace(/[^A-Za-z0-9+#\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^'+|'+$/g, ''));
  const isContent = (w: string) => {
    const l = w.toLowerCase();
    return l.length >= 3 && !STOPWORDS.has(l) && !STOPWORDS.has(l.replace(/'/g, '')) && !/(ed|ly)$/.test(l) && !/^\d+$/.test(l);
  };
  const phrases: string[] = [];
  let run: string[] = [];
  const flush = () => {
    // A trailing "-ing" word is usually a verb ("working", "shipping"); keep it only inside a phrase.
    while (run.length && /ing$/i.test(run[run.length - 1]!)) run.pop();
    if (run.length) phrases.push(run.slice(-3).join(' ').toLowerCase());
    run = [];
  };
  for (const tok of tokens) {
    if (tok && isContent(tok)) run.push(tok);
    else flush();
  }
  flush();
  const ranked = [...new Set(phrases)].filter((p) => p.length >= 5).sort((a, b) => b.length - a.length);
  for (const w of ranked) {
    if (out.length >= max) break;
    if (!out.some((o) => o.toLowerCase().includes(w) || w.includes(o.toLowerCase()))) out.push(w);
  }
  return out;
}

function lowerFirst(s: string) {
  return s ? s[0]!.toLowerCase() + s.slice(1) : s;
}

/** Returns a transition lead-in and a self-contained question (the part repeated on "say that again"). */
export function topicQuestion(
  config: ScenarioConfig,
  item: AgendaItem,
  variables: Record<string, string>,
  first: boolean,
): { lead: string; question: string } {
  const lead = first ? "Let's start." : 'Moving on.';
  if (item.fixedQuestion) return { lead, question: substituteVariables(item.fixedQuestion, variables).trim() };
  // Agenda topics are written about the participant in the third person ("a time they…"); speak to them.
  const topic = lowerFirst(item.topic.trim().replace(/[.?!]+$/, ''))
    .replace(/\bthemselves\b/gi, 'yourself')
    .replace(/\btheir\b/gi, 'your')
    .replace(/\bthey\b/gi, 'you')
    .replace(/\bthem\b/gi, 'you')
    .replace(/\bthe (candidate|participant|learner)'s\b/gi, 'your');
  const wantsExample = /\b(time|example|situation|experience|accomplishment|project|challenge|decision|mistake|conflict|disagreement)\b/i.test(topic);
  return { lead, question: `I'd like to hear about ${topic}. Could you tell me about that${wantsExample ? ', with a specific example' : ''}?` };
}

const SENTENCE_STARTERS = new Set(['during', 'after', 'before', 'while', 'since', 'last', 'this', 'when', 'then', 'at', 'in', 'on', 'our', 'we', 'so', 'also', 'once', 'recently', 'initially']);

const FOLLOW_UPS = [
  (k: string) => `You mentioned ${k} — what was your specific role in that?`,
  (k: string) => `Could you tell me a bit more about ${k}? What happened, and what was the result?`,
  (k: string) => `When you say ${k}, what does that look like in practice? A concrete example would help.`,
  (k: string) => `What was the hardest part about ${k}, and how did you handle it?`,
];

function isShortOrVague(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words < 12 || (words < 30 && VAGUE_RE.test(text));
}

export interface SimulatorInput {
  config: ScenarioConfig;
  variables: Record<string, string>;
  state: RuntimeState;
  turns: TurnRecord[];
  trigger: GenerationTrigger;
  endSessionEnabled: boolean;
}

/** Decide the simulated agent's next reply. Pure function of its inputs. */
export function simulateAgentTurn(input: SimulatorInput): SimulatorOutput {
  const { config, variables, state, turns, trigger } = input;
  const agenda = effectiveAgenda(config);
  const sim: SimulatorState = { ...state.sim };
  const covered = new Set(state.coveredTopicIds);
  const tools: SimulatorOutput['toolCalls'] = [];
  const maxFollowUps = (a: AgendaItem) => (config.conversation.strategy === 'fixed_questions' ? Math.min(a.maxFollowUps, 1) : a.maxFollowUps);

  // Participant text since the last agent turn.
  const lastAgentIdx = [...turns].reverse().findIndex((t) => t.speaker === 'AGENT' && t.text.trim());
  const since = lastAgentIdx === -1 ? turns : turns.slice(turns.length - lastAgentIdx);
  const said = since
    .filter((t) => t.speaker === 'PARTICIPANT')
    .map((t) => t.text.trim())
    .join(' ')
    .trim();
  const systemSince = since.filter((t) => t.speaker === 'SYSTEM');

  const progress = () =>
    tools.push({
      name: 'update_progress',
      input: { coveredTopicIds: [...covered], currentTopicId: sim.topicIndex >= 0 && sim.topicIndex < agenda.length ? agenda[sim.topicIndex]!.id : 'none' },
    });
  const finish = (text: string, reason: string) => {
    progress();
    if (input.endSessionEnabled) tools.push({ name: 'end_session', input: { reason } });
    return { text, toolCalls: tools, sim };
  };
  const say = (text: string, question?: string) => {
    if (question) sim.lastQuestion = question;
    progress();
    return { text, toolCalls: tools, sim };
  };
  const closingQuestion = () => {
    sim.closingAsked = true;
    const q = 'Before we wrap up, is there anything you would like to add, or any question for me?';
    return say(`That covers everything I wanted to ask. ${q}`, q);
  };
  const nextTopic = (prefix: string) => {
    if (sim.topicIndex >= 0 && sim.topicIndex < agenda.length) covered.add(agenda[sim.topicIndex]!.id);
    let idx = sim.topicIndex + 1;
    while (idx < agenda.length && covered.has(agenda[idx]!.id)) idx++;
    const requiredLeft = agenda.some((a) => a.required && !covered.has(a.id));
    if (idx >= agenda.length || state.phase === 'closing' || (!requiredLeft && config.conversation.ending.endWhenAgendaComplete && agenda.slice(idx).every((a) => !a.required))) {
      sim.topicIndex = agenda.length;
      const r = closingQuestion();
      r.text = `${prefix ? prefix + ' ' : ''}${r.text}`;
      return r;
    }
    const first = sim.topicIndex < 0;
    sim.topicIndex = idx;
    sim.followUps = 0;
    const { lead, question } = topicQuestion(config, agenda[idx]!, variables, first);
    const transition = first ? lead : 'Moving on.';
    return say(`${prefix ? prefix + ' ' : ''}${transition} ${question}`, question);
  };

  // ── Non-participant triggers ──
  if (trigger.kind === 'silence_check_in') {
    return say(
      sim.waitingForMoment
        ? 'No rush at all — just let me know whenever you are ready.'
        : 'Take your time. Would you like me to repeat or rephrase the question?',
    );
  }
  if (trigger.kind === 'false_barge_in' || trigger.kind === 'resume') {
    return say(sim.lastQuestion ? `Sorry — to pick up where I left off: ${sim.lastQuestion}` : 'Sorry, please go ahead.');
  }

  // ── Participant (or tool/document) input ──
  const toolNote = systemSince
    .map((t) => (t.metadata?.kind === 'document' ? `Thanks, I have received ${t.metadata.fileName ?? 'your document'}.` : 'Thanks, I have your answer.'))
    .join(' ');
  if (!said && toolNote) {
    if (state.phase === 'closing' || sim.closingAsked) return finish(`${toolNote} ${closingText(config, variables)}`, 'completed');
    return nextTopic(toolNote);
  }
  if (!said) return say(sim.lastQuestion ? `Sorry, I didn't catch that. ${sim.lastQuestion}` : 'Sorry, I did not catch that — could you say it again?');

  if (STOP_RE.test(said)) {
    return finish(`Of course, we can stop here. ${closingText(config, variables)}`, 'participant_request');
  }
  if (sim.closingAsked) {
    const hasQuestion = /\?\s*$/.test(said) || /^(what|how|when|who|why|can|could|will|is|are|do|does)\b/i.test(said);
    const lead = hasQuestion ? 'Good question — the team will follow up with details on that.' : /\b(no|nothing|all good|that'?s it|i'?m good)\b/i.test(said) ? 'Great.' : 'Thank you for sharing that.';
    return finish(`${lead} ${closingText(config, variables)}`, 'completed');
  }
  if (REPEAT_RE.test(said) && sim.lastQuestion) {
    return say(`Of course. ${sim.lastQuestion}`, sim.lastQuestion);
  }
  if (MOMENT_RE.test(said) && said.split(/\s+/).length <= 12) {
    sim.waitingForMoment = true;
    return say('Sure, take your time — just start whenever you are ready.');
  }
  sim.waitingForMoment = false;

  // Opening: participant responded to the greeting → first topic.
  if (sim.topicIndex < 0) {
    if (!agenda.length) return closingQuestion();
    const lead = READY_RE.test(said) && said.split(/\s+/).length <= 15 ? 'Great.' : 'Thanks for that.';
    return nextTopic(lead);
  }
  if (sim.topicIndex >= agenda.length) return closingQuestion();

  const topic = agenda[sim.topicIndex]!;
  if (DONT_KNOW_RE.test(said) && said.split(/\s+/).length < 25) {
    if (sim.followUps < maxFollowUps(topic) && !sim.lastQuestion.startsWith("That's okay")) {
      sim.followUps++;
      const q = `That's okay — even a small or recent example works. Is there any situation related to ${lowerFirst(topic.topic)} that comes to mind?`;
      return say(q, q);
    }
    return nextTopic("That's perfectly fine — let's move on.");
  }
  if (isShortOrVague(said) && sim.followUps < maxFollowUps(topic)) {
    const [kw] = keywords(said, 1);
    const template = FOLLOW_UPS[(sim.followUps + sim.topicIndex) % FOLLOW_UPS.length]!;
    const q = kw ? template(kw) : 'Could you give me a specific example of that?';
    sim.followUps++;
    return say(q, q);
  }
  // Substantive answer (or follow-ups used up): acknowledge specifically and move on.
  const [kw] = keywords(said, 1);
  const acks = [
    (k: string) => `Thanks — that's helpful context on ${k}.`,
    (k: string) => `Got it — ${k} sounds like a meaningful example.`,
    (k: string) => `That's a clear example, thanks for walking me through ${k}.`,
  ];
  const ack = kw ? acks[sim.topicIndex % acks.length]!(kw) : 'Thank you, that is helpful.';
  return nextTopic(ack);
}
