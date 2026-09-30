'use client';
import type { ReactNode } from 'react';
import { PRIVACY, SCENARIO_TYPE_LABELS, SCENARIO_TYPES, type ValidationIssue } from '@cf/shared';
import { Badge, clsx } from '@/components/ui';
import { NumberField, SelectField, TagsField, TextAreaField, TextField, ToggleField } from '../fields';
import {
  AccessSection,
  AudioSection,
  ChannelsSection,
  ConversationSection,
  CustomFunctionsPicker,
  EndingSection,
  ExtractionSection,
  FlatGroups,
  Group,
  InstructionsSection,
  KnowledgeSection,
  MemoryCoachSection,
  ModelSection,
  PersonaSection,
  RecordingSection,
  RubricSection,
  TimedInstructionsSection,
  ToolsSection,
  TurnTakingSection,
  VariablesSection,
  VoiceFields,
} from '../sections';

export type SectionId = 'identity' | 'behavior' | 'feedback' | 'post' | 'conversation' | 'tools' | 'more';

/** Form sections of Scenario Studio, in order. `paths` route validation issues and AI suggestions. */
export const STUDIO_SECTIONS: Array<{ id: SectionId; title: string; description: string; core: boolean; paths: string[] }> = [
  {
    id: 'identity',
    title: 'Identity',
    description: 'Name, type, and what participants read before they start',
    core: true,
    paths: ['basics.name', 'basics.type', 'basics.publicDescription', 'basics.participantInstructions', 'basics.internalDescription', 'basics.privacy', 'basics.tags'],
  },
  {
    id: 'behavior',
    title: 'AI role & behavior',
    description: 'Persona, objectives, private instructions, agenda, follow-ups and ending',
    core: true,
    paths: ['persona.role', 'persona.name', 'persona.description', 'persona.avatar', 'instructions', 'conversation.strategy', 'conversation.agenda', 'conversation.firstTurn', 'conversation.ending'],
  },
  {
    id: 'feedback',
    title: 'Feedback',
    description: 'Who is evaluated, the weighted rubric, report visibility and human review',
    core: true,
    paths: ['rubric', 'analysis.participantCanSeeFeedback', 'analysis.participantCanSeeScores', 'analysis.requireHumanReview'],
  },
  {
    id: 'post',
    title: 'Post-session',
    description: 'Recording, transcript, analysis, data to extract and notifications',
    core: false,
    paths: ['recording', 'analysis', 'extraction'],
  },
  {
    id: 'conversation',
    title: 'Conversation',
    description: 'Model and voice, language, duration, turn-taking, pauses and timed instructions',
    core: false,
    paths: ['model', 'persona.voice', 'basics.language', 'basics.targetDurationMinutes', 'conversation.turnTaking', 'conversation.timedInstructions', 'audio'],
  },
  {
    id: 'tools',
    title: 'Tools',
    description: 'On-screen tools the AI can use with the participant',
    core: false,
    paths: ['tools.enabled'],
  },
  {
    id: 'more',
    title: 'Knowledge, memory & access',
    description: 'Knowledge, memory, custom functions, variables, channels and access',
    core: false,
    paths: ['knowledge', 'memory', 'coach', 'tools.customFunctionIds', 'variables', 'channels', 'access'],
  },
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`);

/** The section that renders a config path (e.g. rubric.criteria.0.weight → feedback). */
export function sectionForPath(path: string): SectionId {
  let best: { id: SectionId; len: number } | null = null;
  for (const s of STUDIO_SECTIONS) for (const p of s.paths) if (under(path, p) && (!best || p.length > best.len)) best = { id: s.id, len: p.length };
  if (best) return best.id;
  // A parent path (e.g. "tools") belongs to the first section rendering one of its children.
  return STUDIO_SECTIONS.find((s) => s.paths.some((p) => under(p, path)))?.id ?? 'identity';
}

const grid = 'grid gap-4 sm:grid-cols-2';

export function StudioForm({
  open,
  onToggle,
  issues,
  pendingPaths,
}: {
  open: Record<SectionId, boolean>;
  onToggle: (id: SectionId) => void;
  issues: ValidationIssue[];
  pendingPaths: string[];
}) {
  const body: Record<SectionId, ReactNode> = {
    identity: (
      <>
        <div className={grid}>
          <TextField path="basics.name" label="Name" required maxLength={120} />
          <SelectField path="basics.type" label="Type" options={SCENARIO_TYPES.map((t) => ({ value: t, label: SCENARIO_TYPE_LABELS[t] }))} />
        </div>
        <TextAreaField path="basics.publicDescription" label="Public description" required rows={2} hint="Shown in the gallery and before a participant starts." />
        <TextAreaField path="basics.participantInstructions" label="Participant instructions" required rows={4} hint="What participants should do and expect. {{variables}} from the allowlist are filled in." />
        <details className="rounded-md border border-slate-200 p-3">
          <summary className="cursor-pointer text-sm font-medium text-slate-700">More: internal notes, privacy and tags</summary>
          <div className="mt-3 space-y-4">
            <TextAreaField path="basics.internalDescription" label="Internal description" rows={2} hint="Only visible to creators in this workspace." />
            <div className={grid}>
              <SelectField
                path="basics.privacy"
                label="Privacy"
                options={PRIVACY.map((p) => ({ value: p, label: p === 'PRIVATE' ? 'Private (grants & links only)' : p === 'ORGANIZATION' ? 'Organization (all members)' : 'Public (anyone, rate-limited)' }))}
              />
              <TagsField path="basics.tags" label="Tags" />
            </div>
          </div>
        </details>
      </>
    ),
    behavior: (
      <>
        <PersonaSection voice={false} />
        <InstructionsSection />
        <ConversationSection />
        <EndingSection />
      </>
    ),
    feedback: (
      <>
        <RubricSection />
        <Group title="Report visibility & review" description="Scores and feedback are advisory. Hiring and assessment decisions should have a person review them.">
          <div className={grid}>
            <ToggleField path="analysis.participantCanSeeFeedback" label="Participant can see feedback" />
            <ToggleField path="analysis.participantCanSeeScores" label="Participant can see scores" />
            <ToggleField path="analysis.requireHumanReview" label="Require human review" description="Recommended for hiring and assessment." />
          </div>
        </Group>
      </>
    ),
    post: (
      <>
        <RecordingSection />
        <Group title="Analysis & notifications" path="analysis">
          <ToggleField path="analysis.enabled" label="Analyze sessions (feedback, scores, extraction)" />
          <div className={grid}>
            <ToggleField path="analysis.participantCanSeeTranscript" label="Participant can see the transcript" />
            <ToggleField path="analysis.notifyOnComplete" label="Notify reviewers when the analysis is ready" />
          </div>
        </Group>
        <ExtractionSection />
      </>
    ),
    conversation: (
      <>
        <ModelSection />
        <div className="space-y-3 border-t border-slate-100 pt-4">
          <VoiceFields />
        </div>
        <Group title="Language & duration">
          <div className={grid}>
            <TextField path="basics.language" label="Language" hint="BCP-47, e.g. en-US" />
            <NumberField path="basics.targetDurationMinutes" label="Target duration (minutes)" min={1} max={240} hint="The hard cap is under AI role & behavior → Ending." />
          </div>
        </Group>
        <TurnTakingSection />
        <TimedInstructionsSection />
        <AudioSection />
      </>
    ),
    tools: <ToolsSection functions={false} />,
    more: (
      <>
        <KnowledgeSection />
        <MemoryCoachSection />
        <Group title="Custom functions" description="Server-side functions an admin configured for this workspace.">
          <CustomFunctionsPicker />
        </Group>
        <VariablesSection />
        <ChannelsSection />
        <AccessSection />
      </>
    ),
  };

  return (
    <FlatGroups.Provider value={true}>
      <div className="space-y-3" data-testid="studio-form">
        {STUDIO_SECTIONS.map((s, i) => {
          const errors = issues.filter((x) => x.severity === 'error' && sectionForPath(x.path) === s.id).length;
          const pending = pendingPaths.filter((p) => sectionForPath(p) === s.id).length;
          const isOpen = open[s.id];
          return (
            <section key={s.id} id={`studio-sec-${s.id}`} className="scroll-mt-4 rounded-lg border border-slate-200 bg-white" data-testid={`section-${s.id}`}>
              <h2>
                <button type="button" aria-expanded={isOpen} onClick={() => onToggle(s.id)} className="flex w-full items-center justify-between gap-3 rounded-lg px-4 py-3 text-left hover:bg-slate-50">
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-900">
                      {i + 1}. {s.title}
                      {!s.core && <span className="ml-2 text-xs font-normal text-slate-400">Advanced</span>}
                    </span>
                    <span className="block truncate text-xs text-slate-500">{s.description}</span>
                  </span>
                  <span className="flex shrink-0 items-center gap-2">
                    {errors > 0 && <Badge tone="red">{errors} to fix</Badge>}
                    {pending > 0 && <Badge tone="blue">AI suggestion</Badge>}
                    <span aria-hidden className={clsx('text-slate-400 transition', isOpen && 'rotate-180')}>
                      ▾
                    </span>
                  </span>
                </button>
              </h2>
              {isOpen && <div className="space-y-4 border-t border-slate-100 px-4 py-4">{body[s.id]}</div>}
            </section>
          );
        })}
      </div>
    </FlatGroups.Provider>
  );
}
