import {
  getToolDefinition,
  resolveVariables,
  SCENARIO_TYPE_LABELS,
  substituteVariables,
  type ScenarioConfig,
  type ScenarioType,
} from '@cf/shared';
// Installs the time-bounded tester for runtime variable patterns (ReDoS guard).
import '../../common/security/regex-guard';
// Prompt compiler owned by workstream B (runtime). Imported as plain functions (no module coupling).
import { compileDynamicPrompt, compileStablePrompt, PROMPT_VERSION } from '../runtime/engine/prompt-compiler';
import { initialRuntimeState } from '../runtime/runtime.types';

/** Sample values for {{placeholders}}: allowlist defaults, else a visible "[Label]" marker. */
export function sampleVariables(c: ScenarioConfig): Record<string, string> {
  const resolved = resolveVariables(c.variables.allowlist, {});
  const values: Record<string, string> = { ...resolved.values };
  for (const v of c.variables.allowlist) if (!values[v.key]) values[v.key] = `[${v.label || v.key}]`;
  return values;
}

export function defaultConsentNotice(c: ScenarioConfig): string {
  const parts: string[] = [];
  const media = [c.recording.audio && 'audio', c.recording.video && 'video'].filter(Boolean).join(' and ');
  if (media) parts.push(`This conversation will be recorded (${media}).`);
  parts.push('You will be talking with an AI agent, not a person.');
  if (c.analysis.enabled) {
    parts.push('The transcript will be analyzed by AI to produce feedback' + (c.analysis.requireHumanReview ? ', which is reviewed by a person.' : '.'));
  }
  if (media || c.analysis.enabled) parts.push(`Data is kept for up to ${c.recording.retentionDays} days.`);
  return parts.join(' ');
}

/** Participant-facing view of a scenario (what someone sees before and at the start of a session). */
export function participantPreview(c: ScenarioConfig) {
  const vars = sampleVariables(c);
  const sub = (t: string) => substituteVariables(t, vars);
  return {
    name: c.basics.name,
    type: c.basics.type,
    typeLabel: SCENARIO_TYPE_LABELS[c.basics.type as ScenarioType] ?? c.basics.type,
    language: c.basics.language,
    publicDescription: c.basics.publicDescription,
    participantInstructions: sub(c.basics.participantInstructions),
    persona: { name: c.persona.name || null, avatar: c.persona.avatar },
    firstTurn: {
      speaker: c.conversation.firstTurn.speaker,
      text: c.conversation.firstTurn.speaker === 'agent' ? sub(c.conversation.firstTurn.text) : '',
    },
    closingMessage: sub(c.conversation.ending.closingMessage),
    estimatedDurationMinutes: c.basics.targetDurationMinutes,
    maxDurationMinutes: c.conversation.ending.maxDurationMinutes,
    turnTaking: { mode: c.conversation.turnTaking.mode, allowBargeIn: c.conversation.turnTaking.allowBargeIn },
    consent: {
      required: c.recording.audio || c.recording.video || c.analysis.enabled,
      recordAudio: c.recording.audio,
      recordVideo: c.recording.video,
      analysis: c.analysis.enabled,
      retentionDays: c.recording.retentionDays,
      notice: c.recording.consentNotice.trim() || defaultConsentNotice(c),
      customNotice: !!c.recording.consentNotice.trim(),
    },
    afterSession: {
      transcript: c.analysis.participantCanSeeTranscript,
      feedback: c.analysis.enabled && c.analysis.participantCanSeeFeedback,
      scores: c.analysis.enabled && c.rubric.enabled && c.analysis.participantCanSeeScores && c.rubric.visibility === 'participant_and_reviewers',
      humanReview: c.analysis.requireHumanReview,
    },
    visibleTools: c.tools.enabled
      .filter((t) => t.enabled)
      .map((t) => getToolDefinition(t.toolId))
      .filter((d): d is NonNullable<typeof d> => !!d && d.presentsUi && d.status === 'available')
      .map((d) => ({ id: d.id, name: d.name })),
    channels: {
      browser: c.channels.browser.enabled,
      textFallback: c.channels.browser.allowTextFallback,
      captions: c.channels.browser.showCaptions,
      embed: c.channels.embed.enabled,
      phone: c.channels.phone.enabled,
    },
    sampleVariables: vars,
  };
}

/** Compiled system prompt as the runtime would build it at session start (sample variables). */
export function compiledPrompt(c: ScenarioConfig): { prompt: string | null; version: string | null; note: string | null } {
  try {
    const vars = sampleVariables(c);
    const toolHints = c.tools.enabled
      .filter((t) => t.enabled)
      .map((t) => ({ name: t.toolId, hint: t.usageHint || getToolDefinition(t.toolId)?.defaultUsageHint || '' }));
    const stable = compileStablePrompt({
      config: c,
      variables: vars,
      coachMode: c.coach.enabled,
      modality: c.model.voiceMode === 'realtime' ? 'realtime' : 'voice',
      toolHints,
      hasUpdateProgressTool: true,
    });
    const dynamic = compileDynamicPrompt({
      config: c,
      variables: vars,
      participantName: vars.participant_name ?? null,
      memoryFacts: [],
      elapsedMs: 0,
      maxDurationSec: Math.round(c.conversation.ending.maxDurationMinutes * 60),
      state: initialRuntimeState(),
    });
    return { prompt: `${stable}\n\n${dynamic}`, version: PROMPT_VERSION, note: 'Sample variables substituted; coach memory and live state omitted.' };
  } catch (e) {
    return { prompt: null, version: null, note: `Prompt preview unavailable: ${(e as Error)?.message ?? 'compiler error'}` };
  }
}
