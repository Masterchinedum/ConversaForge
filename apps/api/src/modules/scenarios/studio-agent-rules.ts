import { normalizeWeights, WEIGHT_EPSILON, type ScenarioConfig, type ValidationIssue } from '@cf/shared';

/**
 * LOCAL DEVELOPMENT SIMULATOR steps for the Studio agent (no AI provider configured). Deterministic and
 * built only from the draft itself; runs that use them are flagged `simulated` like the rule drafter.
 */

type SimChange = { path: string; valueJson: string; reason: string };
const change = (path: string, value: unknown, reason: string): SimChange => ({ path, valueJson: JSON.stringify(value), reason });

/** Structured, spoken-style AI instructions composed from the draft's own fields. */
export function composeAiInstructions(c: ScenarioConfig): string {
  const who = c.persona.name.trim() ? `${c.persona.name.trim()}, ${c.persona.role.trim() || 'the AI'}` : c.persona.role.trim() || 'the AI';
  const minutes = c.basics.targetDurationMinutes;
  const lines: string[] = [];
  lines.push('## CONTEXT');
  lines.push(`${c.basics.publicDescription.trim() || c.basics.name.trim()} This is a ${minutes}-minute voice conversation.`);
  if (c.instructions.goals.length) lines.push(`The conversation should: ${c.instructions.goals.map((g) => g.replace(/\.$/, '')).join('; ')}.`);
  lines.push('', '## ROLE');
  lines.push(`You are ${who}.${c.persona.description.trim() ? ` ${c.persona.description.trim()}` : ''}`);
  lines.push('', '## FLOW');
  let beat = 1;
  if (c.conversation.firstTurn.speaker === 'agent' && c.conversation.firstTurn.text.trim()) {
    lines.push(`Beat ${beat++} — Open. Say: "${c.conversation.firstTurn.text.trim()}" Then stop and wait for their reply.`);
  } else {
    lines.push(`Beat ${beat++} — Open. Let the participant speak first, then respond naturally.`);
  }
  for (const a of c.conversation.agenda) {
    const ask = c.conversation.strategy !== 'adaptive' && a.fixedQuestion?.trim() ? ` Ask exactly: "${a.fixedQuestion.trim()}"` : '';
    lines.push(
      `Beat ${beat++} — ${a.topic.trim()}.${ask} ${a.guidance.trim()} Up to ${a.maxFollowUps} follow-up${a.maxFollowUps === 1 ? '' : 's'} based on what they actually said${a.required ? '' : ' (optional if time is short)'}.`.replace(/\s+/g, ' '),
    );
  }
  if (c.conversation.ending.closingMessage.trim()) {
    lines.push(`Beat ${beat} — Close. Say: "${c.conversation.ending.closingMessage.trim()}" Wait for their reply before ending.`);
  }
  lines.push('', '## TOOLS');
  lines.push('Call end_session only after the goodbye: say it in one turn, wait for their reply, then end on the next turn if the conversation is complete.');
  lines.push('', '## GUARDRAILS');
  for (const b of c.instructions.boundaries) lines.push(`- ${b.trim()}`);
  lines.push('- One question per turn; never stack two questions.');
  lines.push('- If they pause to think, stay quiet. Do not fill the silence with hints.');
  lines.push('- Do not give feedback or reveal how they are being evaluated during the conversation.');
  lines.push('', '## STYLE');
  lines.push(`Tone: ${c.instructions.tone.trim() || 'professional and warm'}. Plain spoken language, short sentences, no lists or markdown out loud. Keep your turns short; this is their time to talk.`);
  return lines.join('\n');
}

/** Deterministic fixes for common publish errors (the simulator's "fix pass"). */
export function fixPublishErrors(c: ScenarioConfig, issues: ValidationIssue[]): { changes: SimChange[] } {
  const errors = new Set(issues.filter((i) => i.severity === 'error').map((i) => i.path));
  const has = (p: string) => [...errors].some((e) => e === p || e.startsWith(`${p}.`));
  const out: SimChange[] = [];
  if (has('basics.name') && !c.basics.name.trim()) out.push(change('basics.name', 'Untitled practice conversation', 'A name is required to publish'));
  if (has('basics.publicDescription')) out.push(change('basics.publicDescription', `Practice a ${c.basics.targetDurationMinutes}-minute conversation with an AI partner.`, 'Participants need a short description'));
  if (has('basics.participantInstructions')) {
    out.push(change('basics.participantInstructions', `You will talk with an AI for about ${c.basics.targetDurationMinutes} minutes. Speak naturally; you can pause to think.`, 'Participants need to know what to expect'));
  }
  if (has('persona.role')) out.push(change('persona.role', 'Conversation partner', 'The AI needs a role'));
  if (has('instructions.goals')) out.push(change('instructions.goals', ['Have a focused, realistic practice conversation'], 'At least one objective is required'));
  if (has('conversation.firstTurn')) out.push(change('conversation.firstTurn', { speaker: 'agent', text: "Hi, thanks for joining. Shall we get started?" }, 'The AI speaks first, so it needs an opening line'));
  if (has('conversation.ending') || has('basics.targetDurationMinutes')) {
    out.push(
      change(
        'conversation.ending',
        {
          ...c.conversation.ending,
          closingMessage: c.conversation.ending.closingMessage.trim() || 'Thanks for your time. That is all for today.',
          maxDurationMinutes: Math.max(c.conversation.ending.maxDurationMinutes, Math.min(240, c.basics.targetDurationMinutes + 5)),
        },
        'Closing message and a cap above the target duration',
      ),
    );
  }
  if (has('rubric') && c.rubric.criteria.length) {
    const sum = c.rubric.criteria.reduce((s, k) => s + k.weight, 0);
    if (Math.abs(sum - 100) > WEIGHT_EPSILON || c.rubric.criteria.some((k) => k.weight <= 0)) {
      const criteria = normalizeWeights(c.rubric.criteria.map((k) => ({ ...k, weight: k.weight > 0 ? k.weight : 1 })));
      out.push(change('rubric', { ...c.rubric, criteria }, 'Rubric weights now sum to 100'));
    }
  }
  return { changes: out };
}
