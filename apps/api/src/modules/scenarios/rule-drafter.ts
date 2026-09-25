import {
  defaultScenarioConfig,
  getAtPath,
  SCENARIO_TYPE_LABELS,
  stableStringify,
  type EditableFieldPath,
  type ScenarioConfig,
  type ScenarioType,
} from '@cf/shared';
import { isPathLocked } from './scenario-utils';

/**
 * LOCAL DEVELOPMENT SIMULATOR for the drafting assistant — a deterministic, rule-based drafter,
 * not a language model. It parses a short natural-language brief such as
 *   "a 15-minute sales discovery call with a skeptical CFO about our analytics product"
 * and proposes values for fields that are EMPTY in the draft, or that the instruction clearly targets
 * (e.g. "rewrite the rubric", "change the opening line"). Proposals from it are flagged `simulated`.
 */

export interface ProposedChange {
  path: EditableFieldPath;
  value: unknown;
  reason: string;
}

interface TypeKit {
  kind: string;
  aiRole: string;
  participantRole: string;
  /** Whether a "with a …" phrase in the brief describes the AI's persona (vs. the participant). */
  personaFromWith: boolean;
  goals: (s: Ctx) => string[];
  agenda: (s: Ctx) => Array<{ id: string; topic: string; guidance: string; required: boolean; maxFollowUps: number }>;
  rubric: Array<{ id: string; name: string; weight: number; description: string; strongPerformance: string; weakPerformance: string }>;
  extraction: Array<{ key: string; description: string; type: 'text' | 'number' | 'boolean' | 'list' | 'date' }>;
  boundaries: string[];
  firstTurn: (s: Ctx) => string;
  closing: string;
  tone: string;
}

interface Ctx {
  personaName: string;
  persona: string | null;
  subject: string | null;
  minutes: number;
  kind: string;
}

const KITS: Record<ScenarioType, TypeKit> = {
  interview: {
    kind: 'interview',
    aiRole: 'Interviewer',
    participantRole: 'candidate',
    personaFromWith: false,
    goals: (s) => [
      `Understand the candidate's relevant experience${s.subject ? ` for ${s.subject}` : ''}`,
      'Assess ownership and measurable impact in past work',
      'Give the candidate a fair, consistent interview experience',
    ],
    agenda: (s) => [
      { id: 'intro', topic: 'Introduction and background', guidance: 'Keep it brief.', required: true, maxFollowUps: 1 },
      { id: 'experience', topic: `Relevant experience${s.subject ? ` (${s.subject})` : ''}`, guidance: 'Ask for a concrete example; probe for their own actions.', required: true, maxFollowUps: 2 },
      { id: 'challenge', topic: 'A difficult challenge they handled', guidance: 'Probe situation, action and result.', required: true, maxFollowUps: 2 },
      { id: 'questions', topic: 'Questions from the candidate', guidance: 'Answer briefly and generically.', required: false, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'relevance', name: 'Relevant experience', weight: 35, description: 'Examples match the role requirements.', strongPerformance: 'Specific, recent, relevant examples.', weakPerformance: 'Generic or unrelated examples.' },
      { id: 'ownership', name: 'Ownership', weight: 35, description: 'Describes personal actions and decisions.', strongPerformance: 'Clearly states what they did and why.', weakPerformance: 'Only describes what the team did.' },
      { id: 'communication', name: 'Communication', weight: 30, description: 'Clear, structured answers.', strongPerformance: 'Concise, well-structured answers.', weakPerformance: 'Rambling or hard to follow.' },
    ],
    extraction: [
      { key: 'years_experience', description: 'Years of relevant experience mentioned', type: 'number' },
      { key: 'current_title', description: 'Current job title', type: 'text' },
      { key: 'key_skills', description: 'Skills the candidate demonstrated', type: 'list' },
    ],
    boundaries: [
      'Never ask about age, family status, religion, health, nationality or other protected characteristics',
      'Do not promise hiring outcomes',
    ],
    firstTurn: (s) => `Hi, thanks for joining. I'm ${s.personaName}. We have about ${s.minutes} minutes${s.subject ? ` to talk about ${s.subject}` : ''}. Could you start by briefly introducing yourself?`,
    closing: 'Thank you for your time today — that covers everything I wanted to ask. Best of luck!',
    tone: 'professional and warm',
  },
  sales_practice: {
    kind: 'sales call',
    aiRole: 'Prospective buyer',
    participantRole: 'seller',
    personaFromWith: true,
    goals: (s) => [
      `Give the seller a realistic chance to uncover the buyer's needs${s.subject ? ` related to ${s.subject}` : ''}`,
      'Test how the seller handles objections and skepticism',
      'Reward good discovery with a concrete next step',
    ],
    agenda: () => [
      { id: 'opening', topic: 'Seller opens and sets the agenda', guidance: 'Warm up only if the seller confirms time and purpose.', required: true, maxFollowUps: 1 },
      { id: 'situation', topic: 'Current situation and challenges', guidance: 'Reveal details only when asked specific, open questions.', required: true, maxFollowUps: 2 },
      { id: 'impact', topic: 'Business impact of the problem', guidance: 'Share the cost of the problem when the seller asks about consequences.', required: true, maxFollowUps: 2 },
      { id: 'objections', topic: 'Objections (price, timing, past experience)', guidance: 'Raise at least one objection naturally.', required: true, maxFollowUps: 2 },
      { id: 'next-step', topic: 'Decision process and next step', guidance: 'Agree to a next step only after good discovery.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'discovery', name: 'Discovery questions', weight: 35, description: 'Open, specific questions that uncover needs.', strongPerformance: 'Layered open questions that follow the buyer’s answers.', weakPerformance: 'Pitches early; closed or generic questions.' },
      { id: 'impact', name: 'Quantifying impact', weight: 25, description: 'Connects the problem to business cost.', strongPerformance: 'Quantifies the cost of the problem.', weakPerformance: 'Never learns why the problem matters.' },
      { id: 'objections', name: 'Objection handling', weight: 20, description: 'Acknowledges and addresses concerns.', strongPerformance: 'Validates, clarifies, answers with specifics.', weakPerformance: 'Defensive or dismissive.' },
      { id: 'next-step', name: 'Next step', weight: 20, description: 'Secures a concrete next step.', strongPerformance: 'Specific meeting with attendees and purpose.', weakPerformance: 'Vague follow-up.' },
    ],
    extraction: [
      { key: 'pain_identified', description: 'Main business pain the seller uncovered', type: 'text' },
      { key: 'next_step_agreed', description: 'Whether a concrete next step was agreed', type: 'boolean' },
      { key: 'objections_raised', description: 'Objections the buyer raised', type: 'list' },
    ],
    boundaries: ['Never break character to coach the seller during the call', 'Keep the conversation professional'],
    firstTurn: (s) => `Hi, ${s.personaName} here. I only have about ${s.minutes} minutes, so let's make it count. What did you want to discuss?`,
    closing: "I need to jump to my next meeting. Thanks for the time.",
    tone: 'businesslike and guarded',
  },
  negotiation: {
    kind: 'negotiation',
    aiRole: 'Counterpart in the negotiation',
    participantRole: 'negotiator',
    personaFromWith: true,
    goals: (s) => [
      `Create realistic negotiation pressure${s.subject ? ` about ${s.subject}` : ''}`,
      'Reward participants who trade concessions for value',
      'Reach a clear outcome by the end',
    ],
    agenda: () => [
      { id: 'anchor', topic: 'Opening positions', guidance: 'Anchor firmly.', required: true, maxFollowUps: 1 },
      { id: 'interests', topic: 'Exploring interests', guidance: 'Reveal underlying interests only when asked.', required: true, maxFollowUps: 2 },
      { id: 'trade', topic: 'Trading concessions', guidance: 'Move only in exchange for something of value.', required: true, maxFollowUps: 3 },
      { id: 'close', topic: 'Agreement or impasse', guidance: 'Summarize the terms before ending.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'preparation', name: 'Anchoring & framing', weight: 25, description: 'Responds well to the opening anchor.', strongPerformance: 'Reframes around value instead of accepting the anchor.', weakPerformance: 'Accepts the anchor or counters immediately.' },
      { id: 'interests', name: 'Exploring interests', weight: 25, description: 'Learns what the other side needs.', strongPerformance: 'Uncovers underlying interests.', weakPerformance: 'Negotiates only on the headline number.' },
      { id: 'trading', name: 'Trading concessions', weight: 30, description: 'Concessions are conditional.', strongPerformance: '"If you…, then I…" offers.', weakPerformance: 'Gives concessions away.' },
      { id: 'outcome', name: 'Outcome clarity', weight: 20, description: 'Clear terms at the end.', strongPerformance: 'Terms summarized and agreed.', weakPerformance: 'Ends without clarity.' },
    ],
    extraction: [
      { key: 'deal_reached', description: 'Whether both sides agreed on terms', type: 'boolean' },
      { key: 'final_terms', description: 'Summary of the final terms', type: 'text' },
      { key: 'concessions_made', description: 'Concessions the participant made', type: 'list' },
    ],
    boundaries: ['Do not reveal your walk-away point directly', 'Stay professional; no threats or insults'],
    firstTurn: (s) => `Thanks for making the time. I'll be direct${s.subject ? ` about ${s.subject}` : ''}: what you've proposed doesn't work for us as it stands. Where can you move?`,
    closing: "Okay. Let's confirm these terms in writing. Thanks.",
    tone: 'polite, firm and deliberate',
  },
  leadership: {
    kind: 'leadership conversation',
    aiRole: 'Direct report',
    participantRole: 'manager',
    personaFromWith: true,
    goals: (s) => [
      `Give the manager a realistic conversation to practice${s.subject ? ` about ${s.subject}` : ''}`,
      'Reward specific, behavior-based feedback and active listening',
      'Let the conversation end with an agreed plan when the manager earns it',
    ],
    agenda: () => [
      { id: 'purpose', topic: 'Manager states the purpose', guidance: 'React naturally.', required: true, maxFollowUps: 1 },
      { id: 'observations', topic: 'Specific observations and impact', guidance: 'Push back on anything vague.', required: true, maxFollowUps: 2 },
      { id: 'perspective', topic: 'Your perspective', guidance: 'Open up when the manager listens well.', required: true, maxFollowUps: 2 },
      { id: 'plan', topic: 'Agreeing next steps', guidance: 'Engage if the plan is concrete and shared.', required: true, maxFollowUps: 2 },
    ],
    rubric: [
      { id: 'specificity', name: 'Specific feedback', weight: 30, description: 'Describes observable behavior and impact.', strongPerformance: 'Concrete examples and effects.', weakPerformance: 'Labels and generalizations.' },
      { id: 'listening', name: 'Listening & empathy', weight: 30, description: 'Asks open questions and reflects.', strongPerformance: 'Curious and paraphrases.', weakPerformance: 'Interrupts or argues.' },
      { id: 'clarity', name: 'Clear expectations', weight: 20, description: 'States the standard clearly.', strongPerformance: 'Clear and kind.', weakPerformance: 'Message diluted.' },
      { id: 'plan', name: 'Shared plan', weight: 20, description: 'Agrees on actions and follow-up.', strongPerformance: 'Actions, owners, check-in date.', weakPerformance: 'No plan.' },
    ],
    extraction: [
      { key: 'agreed_actions', description: 'Actions agreed at the end', type: 'list' },
      { key: 'follow_up_set', description: 'Whether a follow-up was scheduled', type: 'boolean' },
      { key: 'main_concern', description: 'The main concern raised by the direct report', type: 'text' },
    ],
    boundaries: ['Stay in character; do not coach the manager during the conversation', 'Keep personal details general'],
    firstTurn: () => '',
    closing: 'Okay. Thanks for talking this through with me.',
    tone: 'natural, a little tense at first',
  },
  demo: {
    kind: 'product demo',
    aiRole: 'Product specialist',
    participantRole: 'visitor',
    personaFromWith: false,
    goals: (s) => [
      'Understand the visitor’s role and goal',
      `Show the most relevant capabilities${s.subject ? ` of ${s.subject}` : ''} clearly`,
      'Answer questions accurately and capture follow-up interest',
    ],
    agenda: () => [
      { id: 'discovery', topic: 'Visitor role and goal', guidance: 'Two questions maximum.', required: true, maxFollowUps: 1 },
      { id: 'walkthrough', topic: 'Walkthrough of relevant capabilities', guidance: 'Tie each capability to what the visitor said.', required: true, maxFollowUps: 3 },
      { id: 'questions', topic: 'Visitor questions', guidance: 'Answer from the knowledge base only.', required: false, maxFollowUps: 3 },
      { id: 'next', topic: 'Next step', guidance: 'Offer a trial or a call.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'relevance', name: 'Relevance to visitor', weight: 50, description: 'Demo matched the visitor’s stated goal.', strongPerformance: 'Every capability tied to the goal.', weakPerformance: 'Generic tour.' },
      { id: 'clarity', name: 'Clarity', weight: 50, description: 'Explanations were short and clear.', strongPerformance: 'Concise and concrete.', weakPerformance: 'Jargon-heavy or long-winded.' },
    ],
    extraction: [
      { key: 'visitor_role', description: 'The visitor’s job role', type: 'text' },
      { key: 'primary_goal', description: 'Main goal or use case', type: 'text' },
      { key: 'wants_follow_up', description: 'Whether the visitor asked for a follow-up', type: 'boolean' },
    ],
    boundaries: ['Never invent pricing, roadmap dates or customer names', 'Do not disparage competitors'],
    firstTurn: (s) => `Hi! I'm ${s.personaName}. I'll give you a quick tour${s.subject ? ` of ${s.subject}` : ''} tailored to what you need. What's your role, and what are you hoping to get done?`,
    closing: 'Thanks for taking the tour! A colleague will follow up with the links we discussed.',
    tone: 'friendly, clear and upbeat',
  },
  support: {
    kind: 'support call',
    aiRole: 'Customer',
    participantRole: 'support agent',
    personaFromWith: true,
    goals: (s) => [
      `Present a realistic customer issue${s.subject ? ` about ${s.subject}` : ''}`,
      'Reward empathy, ownership and a clear resolution',
    ],
    agenda: () => [
      { id: 'problem', topic: 'Customer explains the problem', guidance: 'Be emotional but specific.', required: true, maxFollowUps: 1 },
      { id: 'acknowledge', topic: 'Agent acknowledges and takes ownership', guidance: 'Soften when done well.', required: true, maxFollowUps: 2 },
      { id: 'resolve', topic: 'Resolution options', guidance: 'Ask what can actually be guaranteed.', required: true, maxFollowUps: 2 },
      { id: 'confirm', topic: 'Confirmation of next steps', guidance: 'Ask how you will be kept informed.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'empathy', name: 'Empathy', weight: 30, description: 'Acknowledges the customer’s frustration.', strongPerformance: 'Specific, sincere acknowledgement.', weakPerformance: 'Scripted or absent.' },
      { id: 'ownership', name: 'Ownership', weight: 25, description: 'Takes responsibility.', strongPerformance: 'No blame; "let me fix this".', weakPerformance: 'Blames others.' },
      { id: 'resolution', name: 'Resolution', weight: 30, description: 'Concrete fix within policy.', strongPerformance: 'Clear options within policy.', weakPerformance: 'Vague promises.' },
      { id: 'close', name: 'Clear close', weight: 15, description: 'Confirms next steps.', strongPerformance: 'Summarizes resolution.', weakPerformance: 'Ends abruptly.' },
    ],
    extraction: [
      { key: 'issue_category', description: 'Category of the customer’s issue', type: 'text' },
      { key: 'resolution_offered', description: 'Resolution the agent offered', type: 'text' },
      { key: 'customer_satisfied', description: 'Whether the customer ended satisfied', type: 'boolean' },
    ],
    boundaries: ['No profanity or personal insults', 'Stay in character as the customer'],
    firstTurn: (s) => `Hi — I'm calling because I have a problem${s.subject ? ` with ${s.subject}` : ''} and honestly I'm pretty frustrated. Can you help me?`,
    closing: 'Okay, thank you for sorting this out.',
    tone: 'frustrated at first, calmer when treated well',
  },
  coaching: {
    kind: 'coaching session',
    aiRole: 'Coach',
    participantRole: 'learner',
    personaFromWith: false,
    goals: (s) => [
      `Teach one practical technique${s.subject ? ` for ${s.subject}` : ''}`,
      'Give the learner deliberate practice',
      'Give specific, encouraging feedback and one next step',
    ],
    agenda: () => [
      { id: 'checkin', topic: 'Check-in and goals', guidance: 'Ask what they want to improve.', required: true, maxFollowUps: 1 },
      { id: 'teach', topic: 'Mini-lesson', guidance: 'Under a minute, with an example.', required: true, maxFollowUps: 1 },
      { id: 'practice', topic: 'Practice round', guidance: 'Role-play; give room to practice.', required: true, maxFollowUps: 3 },
      { id: 'feedback', topic: 'Feedback and next step', guidance: 'Two strengths, one thing to try.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'application', name: 'Applies the technique', weight: 60, description: 'Uses the taught technique in practice.', strongPerformance: 'Consistent, natural use.', weakPerformance: 'Does not use it.' },
      { id: 'reflection', name: 'Reflection', weight: 40, description: 'Reflects on what worked.', strongPerformance: 'Specific insights.', weakPerformance: 'No reflection.' },
    ],
    extraction: [
      { key: 'focus_skill', description: 'Skill practiced in this session', type: 'text' },
      { key: 'next_focus', description: 'What to try next time', type: 'text' },
    ],
    boundaries: ['You are a skills coach, not a therapist', 'Never share information about other learners'],
    firstTurn: (s) => `Hi, I'm ${s.personaName}, your coach. In the next ${s.minutes} minutes we'll learn one technique and practice it. What would you like to get better at?`,
    closing: 'Great work today. Keep practicing and we will build on this next time.',
    tone: 'warm, encouraging and practical',
  },
  custom: {
    kind: 'conversation',
    aiRole: 'Conversation partner',
    participantRole: 'participant',
    personaFromWith: true,
    goals: (s) => [`Have a focused conversation${s.subject ? ` about ${s.subject}` : ''}`, 'Keep the conversation on track and within time'],
    agenda: (s) => [
      { id: 'opening', topic: 'Opening and context', guidance: 'Set expectations.', required: true, maxFollowUps: 1 },
      { id: 'main', topic: s.subject ? `Discussion: ${s.subject}` : 'Main discussion', guidance: 'Ask open questions and follow up.', required: true, maxFollowUps: 3 },
      { id: 'close', topic: 'Summary and close', guidance: 'Summarize key points.', required: true, maxFollowUps: 1 },
    ],
    rubric: [
      { id: 'clarity', name: 'Clarity', weight: 50, description: 'Communicates clearly.', strongPerformance: 'Clear and concise.', weakPerformance: 'Unclear.' },
      { id: 'engagement', name: 'Engagement', weight: 50, description: 'Engages with the conversation.', strongPerformance: 'Thoughtful responses.', weakPerformance: 'Minimal engagement.' },
    ],
    extraction: [{ key: 'key_points', description: 'Key points raised by the participant', type: 'list' }],
    boundaries: ['Stay on topic and politely decline unrelated requests'],
    firstTurn: (s) => `Hi, I'm ${s.personaName}. Thanks for joining${s.subject ? ` — let's talk about ${s.subject}` : ''}. Shall we get started?`,
    closing: 'Thanks for the conversation — that is all for today.',
    tone: 'professional and warm',
  },
};

const TYPE_RULES: Array<[ScenarioType, RegExp]> = [
  ['negotiation', /\bnegotiat|\bhaggl|\bprice (?:talk|discussion)|\bsalary (?:talk|negotiation)|\brenewal\b/],
  ['sales_practice', /\bsales\b|\bdiscovery call|\bcold call|\bprospect|\bselling\b|\bpitch\b|\bobjection/],
  ['interview', /\binterview|\bhiring\b|\bcandidate|\brecruit|\bscreening call/],
  ['leadership', /\bdifficult (?:feedback|conversation)|\bfeedback conversation|\bone[- ]on[- ]one|\b1:1\b|\bdirect report|\bperformance review|\bleadership/],
  ['support', /\bcustomer support|\bsupport call|\bde-?escalat|\bangry customer|\bcomplaint|\bhelp ?desk/],
  ['demo', /\bdemo\b|\bwalkthrough|\bwalk-through|\bproduct tour/],
  ['coaching', /\bcoach|\bmentor|\bpractice session|\btutor/],
];

const TRAITS = ['skeptical', 'busy', 'angry', 'frustrated', 'friendly', 'demanding', 'tough', 'curious', 'impatient', 'defensive', 'nervous', 'senior', 'junior', 'technical', 'aggressive', 'polite', 'cautious', 'enthusiastic'];

const NAMES = ['Alex', 'Jordan', 'Sam', 'Taylor', 'Morgan', 'Casey', 'Riley', 'Avery', 'Quinn', 'Drew'];

export function detectType(text: string): ScenarioType | null {
  const lower = text.toLowerCase();
  for (const [type, re] of TYPE_RULES) if (re.test(lower)) return type;
  return null;
}

export function detectMinutes(text: string): number | null {
  const lower = text.toLowerCase();
  const m = lower.match(/(\d{1,3})\s*[- ]?\s*(?:min(?:ute)?s?)\b/);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 240) return n;
  }
  if (/\bhalf an hour\b/.test(lower)) return 30;
  if (/\b(?:an|one) hour\b/.test(lower)) return 60;
  return null;
}

function detectWithPhrase(text: string): string | null {
  const m = text.match(
    /\bwith (?:a |an |the |my |our |some )?([a-z][a-z0-9 \-']{1,60}?)(?=\s+(?:about|regarding|on|for|who|that|to|in|at|over)\b|[,.;:!?]|$)/i,
  );
  if (!m) return null;
  const phrase = m[1]!.trim();
  if (!phrase || /^(me|us|you|them|him|her|it)$/i.test(phrase)) return null;
  return phrase;
}

function detectSubject(text: string): string | null {
  const m = text.match(/\b(?:about|regarding|on the topic of|focused on|covering)\s+([^,.;:!?]{3,80})/i);
  return m ? m[1]!.trim() : null;
}

function detectTraits(text: string): string[] {
  const lower = text.toLowerCase();
  return TRAITS.filter((t) => new RegExp(`\\b${t}\\b`).test(lower));
}

function capitalize(s: string) {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s;
}

function hashIndex(s: string, n: number) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % n;
}

const TARGETS: Array<[RegExp, EditableFieldPath[]]> = [
  [/\b(?:rename|call it|title|the name)\b/, ['basics.name']],
  [/\bpublic description|\bdescription\b/, ['basics.publicDescription']],
  [/\bparticipant instructions|\binstructions for (?:the )?participant/, ['basics.participantInstructions']],
  [/\bpersona\b|\bcharacter\b|\brole[- ]?play/, ['persona.role', 'persona.description']],
  [/\bgoals?\b|\bobjectives?\b/, ['instructions.goals']],
  [/\bboundar|\bnever\b|\bmust not\b|\bdo not\b|\bdon't\b/, ['instructions.boundaries']],
  [/\btone\b|\bfriendlier|\bmore formal|\bcasual\b/, ['instructions.tone']],
  [/\bagenda\b|\btopics\b/, ['conversation.agenda']],
  [/\bfirst (?:turn|line|message|question)|\bopening\b|\bopen with\b|\bgreeting\b/, ['conversation.firstTurn']],
  [/\bclosing\b|\bclose with\b|\bgoodbye\b|\bwrap[- ]?up\b/, ['conversation.ending']],
  [/\brubric\b|\bcriteri|\bscoring\b|\bevaluat|\bassess/, ['rubric']],
  [/\bextract|\bcapture\b|\bdata points?\b|\bvariables?\b/, ['extraction.variables']],
];

function isEmptyValue(v: unknown, def: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (typeof v === 'string') return v.trim() === '';
  if (Array.isArray(v)) return v.length === 0;
  return stableStringify(v) === stableStringify(def);
}

export function ruleBasedDraft(instruction: string, draft: ScenarioConfig, lockedFields: readonly string[]): { changes: ProposedChange[]; notes: string[] } {
  const lower = instruction.toLowerCase();
  const defaults = defaultScenarioConfig();
  const detectedType = detectType(instruction);
  const type: ScenarioType = detectedType ?? (draft.basics.type as ScenarioType) ?? 'custom';
  const kit = KITS[type];
  const minutes = detectMinutes(instruction);
  const withPhrase = detectWithPhrase(instruction);
  const subject = detectSubject(instruction);
  const traits = detectTraits(instruction);
  const personaPhrase = kit.personaFromWith ? withPhrase : null;
  const effMinutes = minutes ?? draft.basics.targetDurationMinutes;
  const personaName = draft.persona.name.trim() || NAMES[hashIndex(instruction, NAMES.length)]!;
  const ctx: Ctx = { personaName, persona: personaPhrase, subject, minutes: effMinutes, kind: kit.kind };

  const targeted = new Set<EditableFieldPath>();
  for (const [re, paths] of TARGETS) if (re.test(lower)) paths.forEach((p) => targeted.add(p));
  if (minutes !== null) {
    targeted.add('basics.targetDurationMinutes');
    targeted.add('conversation.ending');
  }
  if (detectedType && detectedType !== draft.basics.type) targeted.add('basics.type');
  if (personaPhrase) {
    targeted.add('persona.role');
    targeted.add('persona.description');
  }

  const changes: ProposedChange[] = [];
  const notes: string[] = [];
  const propose = (path: EditableFieldPath, value: unknown, reason: string) => {
    if (isPathLocked(path, lockedFields)) return;
    const current = getAtPath(draft, path);
    const def = getAtPath(defaults, path);
    if (!isEmptyValue(current, def) && !targeted.has(path)) return;
    if (stableStringify(current ?? null) === stableStringify(value ?? null)) return;
    changes.push({ path, value, reason });
  };

  const kindLabel = type === 'custom' ? 'Conversation' : SCENARIO_TYPE_LABELS[type];
  const personaLabel = personaPhrase ? `${/^[aeiou]/i.test(personaPhrase) ? 'an' : 'a'} ${personaPhrase}` : null;
  const kindPhrase = extractKindPhrase(instruction) ?? kit.kind;
  const name = truncate(capitalize(`${kindPhrase}${personaLabel ? ` with ${personaLabel}` : ''}${!personaLabel && subject ? ` about ${subject}` : ''}`), 120);

  propose('basics.name', name, 'Named after the scenario described in the instruction');
  if (detectedType) propose('basics.type', type, `The instruction describes a ${kindLabel.toLowerCase()} scenario`);
  if (minutes !== null) propose('basics.targetDurationMinutes', minutes, `The instruction asks for about ${minutes} minutes`);

  const aboutSubject = subject ? ` about ${subject}` : '';
  propose(
    'basics.publicDescription',
    `Practice a ${effMinutes}-minute ${kindPhrase}${personaLabel ? ` with ${personaLabel}` : ''}${aboutSubject}.`,
    'Participants see this in the gallery and before starting',
  );
  propose(
    'basics.participantInstructions',
    `You will talk with an AI ${kit.aiRole.toLowerCase()} for about ${effMinutes} minutes. You play the ${kit.participantRole}.${subject ? ` The conversation is about ${subject}.` : ''} Speak naturally; you can pause to think and the AI will wait.`,
    'Tells participants what to expect and what role they play',
  );

  const aiRole = personaPhrase
    ? `${capitalize(personaPhrase)}${subject && type !== 'support' ? ` discussing ${subject}` : ''}`
    : `${kit.aiRole}${subject ? ` for ${subject}` : ''}`;
  propose('persona.role', truncate(aiRole, 1000), personaPhrase ? `The instruction asks for ${personaLabel}` : `Default AI role for a ${kit.kind}`);
  propose('persona.name', personaName, 'A name makes the persona feel real');
  const traitText = traits.length ? `${capitalize(traits.join(', '))}. ` : '';
  propose(
    'persona.description',
    `${traitText}${personaPhrase ? `Plays ${personaLabel}` : `Acts as the ${kit.aiRole.toLowerCase()}`} in a ${kit.kind}${aboutSubject}. Stays in character, keeps answers short (this is a voice conversation), and reacts realistically to how the ${kit.participantRole} behaves.`,
    'Persona description derived from the instruction',
  );

  propose(
    'instructions.aiInstructions',
    `Ask or say one thing at a time and keep turns short. ${personaPhrase ? `Stay in character as ${personaLabel}${traits.length ? ` (${traits.join(', ')})` : ''}. ` : ''}Follow the agenda, but adapt follow-up questions to what the ${kit.participantRole} says. Do not give feedback during the conversation.`,
    'Baseline behavior instructions for a voice conversation',
  );
  propose('instructions.goals', kit.goals(ctx), `Typical goals for a ${kit.kind}`);

  const boundaryMatches = [...instruction.matchAll(/\b(?:never|must not|do not|don't)\s+([^.;!?\n]{3,200})/gi)].map((m) => `Never ${m[1]!.trim()}`);
  if (boundaryMatches.length) {
    const merged = Array.from(new Set([...draft.instructions.boundaries, ...boundaryMatches])).slice(0, 30);
    propose('instructions.boundaries', merged, 'Adds the boundaries stated in the instruction');
  } else {
    propose('instructions.boundaries', kit.boundaries, `Standard boundaries for a ${kit.kind}`);
  }
  const tone = traits.length && kit.personaFromWith ? `${traits.join(', ')} but professional` : /friendlier|friendly/.test(lower) ? 'friendly and warm' : /formal/.test(lower) ? 'formal and precise' : kit.tone;
  propose('instructions.tone', tone, 'Tone matching the persona');

  propose('conversation.agenda', kit.agenda(ctx), `A ${kit.kind} agenda with required topics`);
  const firstText = kit.firstTurn(ctx);
  propose(
    'conversation.firstTurn',
    firstText ? { speaker: 'agent', text: firstText } : { speaker: 'participant', text: '' },
    firstText ? 'Opening line for the AI' : `In a ${kit.kind} the ${kit.participantRole} usually opens`,
  );
  const maxDuration = Math.min(240, Math.max(effMinutes + 5, Math.ceil(effMinutes * 1.5)));
  propose(
    'conversation.ending',
    {
      ...draft.conversation.ending,
      closingMessage: draft.conversation.ending.closingMessage.trim() && !/\bclosing\b|\bgoodbye\b/.test(lower) ? draft.conversation.ending.closingMessage : kit.closing,
      maxDurationMinutes: minutes !== null ? maxDuration : Math.max(draft.conversation.ending.maxDurationMinutes, effMinutes),
      wrapUpLeadMinutes: Math.min(draft.conversation.ending.wrapUpLeadMinutes, Math.max(1, Math.floor(effMinutes / 5))),
    },
    `Closing message and a hard cap a little above the ${effMinutes}-minute target`,
  );

  propose(
    'rubric',
    {
      ...draft.rubric,
      enabled: true,
      evaluatedSubject: `the ${kit.participantRole} (participant)`,
      criteria: kit.rubric,
    },
    `Rubric for a ${kit.kind}; weights sum to 100`,
  );
  propose('extraction.variables', kit.extraction, 'Structured data worth capturing from this kind of conversation');

  if (!changes.length) {
    notes.push(
      'The local simulator only fills empty fields or fields the instruction names explicitly (e.g. "rubric", "opening line", "agenda", "15 minutes"). Configure an AI provider for free-form edits.',
    );
  }
  return { changes, notes };
}

function extractKindPhrase(text: string): string | null {
  const m = text.match(
    /\b((?:[a-z][a-z-]*\s){0,3}(?:interview|call|negotiation|conversation|demo|walkthrough|session|meeting|review|one-on-one|1:1|pitch))\b/i,
  );
  if (!m) return null;
  // "a 10-minute sales call" can match from "minute …" (the digits are not part of the word class).
  const phrase = m[1]!
    .trim()
    .replace(/^(?:a|an|the|\d+[- ]?minutes?|\d+[- ]?min)\s+/i, '')
    .replace(/^(?:\d+[- ]?minutes?|\d+[- ]?min|minutes?|min)\s+/i, '')
    .replace(/^(?:a|an|the)\s+/i, '');
  return phrase.length >= 3 ? phrase.toLowerCase() : null;
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n).trim() : s;
}
