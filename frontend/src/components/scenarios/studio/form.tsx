'use client';
import { useState, type ReactNode } from 'react';
import { PRIVACY, SCENARIO_TYPE_LABELS, SCENARIO_TYPES, type RubricCriterion, type ValidationIssue } from '@cf/shared';
import { Badge, Button, Input, Modal, Select, Textarea, clsx } from '@/components/ui';
import { fieldDomId, useEditor, useField } from '../editor-context';
import { AudienceBadge, LockButton, NumberField, SelectField, TagsField, TextAreaField, ToggleField } from '../fields';
import { Icon, type IconName } from '../icons';
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

export type SectionId = 'core' | 'rubric' | 'behavior' | 'feedback' | 'post' | 'conversation' | 'tools' | 'more';

/** Form layout of Scenario Studio. `paths` route validation issues, AI marks and "Show field" links. */
export const STUDIO_SECTIONS: Array<{ id: SectionId; title: string; description: string; paths: string[] }> = [
  { id: 'core', title: 'Scenario', description: 'Name, type, description and instructions', paths: ['basics.name', 'basics.type', 'basics.publicDescription', 'basics.participantInstructions', 'instructions.aiInstructions'] },
  { id: 'rubric', title: 'Rubric', description: 'How the session is scored', paths: ['rubric'] },
  {
    id: 'behavior',
    title: 'AI role & behavior',
    description: 'Persona, objectives, boundaries, first turn, agenda, follow-ups and ending',
    paths: ['persona.role', 'persona.name', 'persona.description', 'persona.avatar', 'instructions', 'conversation.strategy', 'conversation.agenda', 'conversation.firstTurn', 'conversation.ending'],
  },
  { id: 'feedback', title: 'Feedback & review', description: 'Report visibility and human review', paths: ['analysis.participantCanSeeFeedback', 'analysis.participantCanSeeScores', 'analysis.requireHumanReview'] },
  { id: 'post', title: 'Post-session', description: 'Recording, transcript, analysis, data to extract and notifications', paths: ['recording', 'analysis', 'extraction'] },
  {
    id: 'conversation',
    title: 'Conversation',
    description: 'Model and voice, language, duration, turn-taking, pauses and timed instructions',
    paths: ['model', 'persona.voice', 'basics.language', 'basics.targetDurationMinutes', 'conversation.turnTaking', 'conversation.timedInstructions', 'audio'],
  },
  { id: 'tools', title: 'Tools', description: 'On-screen tools the AI can use with the participant', paths: ['tools.enabled'] },
  {
    id: 'more',
    title: 'Knowledge, memory & access',
    description: 'Knowledge, memory, custom functions, variables, channels, access, privacy and tags',
    paths: ['knowledge', 'memory', 'coach', 'tools.customFunctionIds', 'variables', 'channels', 'access', 'basics.internalDescription', 'basics.privacy', 'basics.tags'],
  },
];
const COLLAPSIBLE = STUDIO_SECTIONS.filter((s) => s.id !== 'core' && s.id !== 'rubric');

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}.`);

/** The section that renders a config path (e.g. rubric.criteria.0.weight → rubric). */
export function sectionForPath(path: string): SectionId {
  let best: { id: SectionId; len: number } | null = null;
  for (const s of STUDIO_SECTIONS) for (const p of s.paths) if (under(path, p) && (!best || p.length > best.len)) best = { id: s.id, len: p.length };
  if (best) return best.id;
  return STUDIO_SECTIONS.find((s) => s.paths.some((p) => under(p, path)))?.id ?? 'core';
}

export const QUICK_PROMPTS = [
  'Rewrite the AI instructions as a clear beat-by-beat flow with guardrails and style notes.',
  'Make the persona more challenging, but keep it fair and realistic.',
  'Keep the AI to one question per turn and shorter spoken replies.',
  'Add guardrails for off-topic questions and requests to reveal the scoring.',
  'Tighten the closing so the AI wraps up and ends the session cleanly.',
];

const grid = 'grid gap-4 sm:grid-cols-2';

export function StudioForm({
  open,
  onToggle,
  issues,
  pendingPaths,
  onAgent,
  agentBusy,
}: {
  open: Record<SectionId, boolean>;
  onToggle: (id: SectionId) => void;
  issues: ValidationIssue[];
  pendingPaths: string[];
  /** Ask the assistant (Quick Prompts, name wand). */
  onAgent: (instruction: string, mode: 'standard' | 'flash') => void;
  agentBusy: boolean;
}) {
  const { lockedFields } = useEditor();
  const [rubricView, setRubricView] = useState<'edit' | 'processed'>('edit');
  const body: Record<Exclude<SectionId, 'core' | 'rubric'>, ReactNode> = {
    behavior: (
      <>
        <PersonaSection voice={false} />
        <InstructionsSection ai={false} />
        <ConversationSection />
        <EndingSection />
      </>
    ),
    feedback: (
      <Group title="Report visibility & review" description="Scores and feedback are advisory. Hiring and assessment decisions should have a person review them.">
        <div className={grid}>
          <ToggleField path="analysis.participantCanSeeFeedback" label="Participant can see feedback" />
          <ToggleField path="analysis.participantCanSeeScores" label="Participant can see scores" />
          <ToggleField path="analysis.requireHumanReview" label="Require human review" description="Recommended for hiring and assessment." />
        </div>
      </Group>
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
            <PlainText path="basics.language" label="Language" hint="BCP-47, e.g. en-US" />
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
        <Group title="Internal notes, privacy & tags">
          <TextAreaField path="basics.internalDescription" label="Internal description" rows={2} hint="Only visible to creators in this workspace." />
          <div className={grid}>
            <SelectField
              path="basics.privacy"
              label="Privacy"
              options={PRIVACY.map((p) => ({ value: p, label: p === 'PRIVATE' ? 'Private (grants & links only)' : p === 'ORGANIZATION' ? 'Organization (all members)' : 'Public (anyone, rate-limited)' }))}
            />
            <TagsField path="basics.tags" label="Tags" />
          </div>
        </Group>
      </>
    ),
  };
  const errorsIn = (id: SectionId) => issues.filter((x) => x.severity === 'error' && sectionForPath(x.path) === id).length;
  const nameLocked = lockedFields.includes('basics.name');

  return (
    <FlatGroups.Provider value={true}>
      <div className="space-y-5" data-testid="studio-form">
        <Card>
          <StudioText
            path="basics.name"
            icon="type"
            label="Name"
            placeholder="e.g. PM interviewer: analytics case, Sales coach: enterprise discovery"
            action={
              <button
                type="button"
                className="text-slate-400 hover:text-brand-700 disabled:opacity-40"
                title={nameLocked ? 'The name is locked' : 'Suggest a name'}
                aria-label="Suggest a name"
                disabled={nameLocked || agentBusy}
                onClick={() => onAgent('Suggest a short, specific name for this scenario (under 60 characters). Change only the name.', 'flash')}
              >
                <Icon name="wand" />
              </button>
            }
          />
          <StudioSelect path="basics.type" icon="layers" label="Type" options={SCENARIO_TYPES.map((t) => ({ value: t, label: SCENARIO_TYPE_LABELS[t] }))} />
          <StudioTextArea path="basics.publicDescription" icon="chat" label="Public Description" rows={3} placeholder="What participants see before starting: the scenario’s purpose and what they’ll practise." />
        </Card>
        <Card>
          <StudioTextArea path="basics.participantInstructions" icon="doc" label="Participant Instructions" rows={6} expandable placeholder="What the participant should do and expect. Supports **bold** and lists." />
        </Card>
        <Card>
          <StudioTextArea
            path="instructions.aiInstructions"
            icon="sparkles"
            label="AI Instructions"
            rows={12}
            mono
            expandable
            placeholder="Private instructions for the AI: context, role, flow, tools, guardrails and style."
            extra={<QuickPrompts disabled={agentBusy || lockedFields.includes('instructions.aiInstructions')} onPick={(p) => onAgent(p, 'standard')} />}
          />
        </Card>

        <section id="studio-sec-rubric" className="space-y-3" data-testid="section-rubric">
          <div className="flex items-center justify-between">
            <button type="button" aria-expanded={open.rubric} onClick={() => onToggle('rubric')} className="flex items-center gap-2 text-left">
              <Icon name={open.rubric ? 'chevronDown' : 'chevronRight'} className="h-4 w-4 text-slate-400" />
              <Icon name="clipboard" className="h-4 w-4 text-brand-600" />
              <span className="font-semibold text-slate-900">Rubric</span>
              <span className="text-sm text-slate-500">(Optional)</span>
              {errorsIn('rubric') > 0 && <Badge tone="red">{errorsIn('rubric')} to fix</Badge>}
              {pendingPaths.includes('rubric') && <Badge tone="blue">AI suggestion</Badge>}
            </button>
          </div>
          {open.rubric && (
            <>
              <div role="tablist" className="flex gap-4 border-b border-slate-200 text-sm">
                {(['edit', 'processed'] as const).map((v) => (
                  <button key={v} type="button" role="tab" aria-selected={rubricView === v} onClick={() => setRubricView(v)} className={clsx('-mb-px flex items-center gap-1.5 border-b-2 px-1 py-1.5', rubricView === v ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500')}>
                    <Icon name={v === 'edit' ? 'pencil' : 'sparkles'} className="h-3.5 w-3.5" />
                    {v === 'edit' ? 'Edit' : 'Processed'}
                  </button>
                ))}
              </div>
              <Card>{rubricView === 'edit' ? <RubricSection /> : <ProcessedRubric />}</Card>
            </>
          )}
        </section>

        <div className="space-y-3">
          <p className="pt-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Advanced settings</p>
          {COLLAPSIBLE.map((s) => {
            const errors = errorsIn(s.id);
            const pending = pendingPaths.filter((p) => sectionForPath(p) === s.id).length;
            const isOpen = open[s.id];
            return (
              <section key={s.id} id={`studio-sec-${s.id}`} className="scroll-mt-4 rounded-xl border border-slate-200 bg-white" data-testid={`section-${s.id}`}>
                <h2>
                  <button type="button" aria-expanded={isOpen} onClick={() => onToggle(s.id)} className="flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left hover:bg-slate-50">
                    <span className="min-w-0">
                      <span className="block text-sm font-semibold text-slate-900">{s.title}</span>
                      <span className="block truncate text-xs text-slate-500">{s.description}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {errors > 0 && <Badge tone="red">{errors} to fix</Badge>}
                      {pending > 0 && <Badge tone="blue">AI suggestion</Badge>}
                      <Icon name="chevronDown" className={clsx('h-4 w-4 text-slate-400 transition', isOpen && 'rotate-180')} />
                    </span>
                  </button>
                </h2>
                {isOpen && <div className="space-y-4 border-t border-slate-100 px-4 py-4">{body[s.id as keyof typeof body]}</div>}
              </section>
            );
          })}
        </div>
      </div>
    </FlatGroups.Provider>
  );
}

function Card({ children }: { children: ReactNode }) {
  return <div className="space-y-5 rounded-xl border border-slate-200 bg-slate-100/60 p-4">{children}</div>;
}

function Header({ path, icon, label, extra }: { path: string; icon: IconName; label: string; extra?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <span className="flex items-center gap-2 whitespace-nowrap text-sm font-semibold text-slate-900">
        <Icon name={icon} className="h-4 w-4 shrink-0 text-brand-600" />
        {label}
        <span className="hidden sm:inline">
          <AudienceBadge path={path} />
        </span>
      </span>
      <span className="ml-auto flex items-center gap-3 whitespace-nowrap">
        {extra}
        <LockButton path={path} />
      </span>
    </div>
  );
}

function FieldError({ path }: { path: string }) {
  const { issues } = useEditor();
  const own = issues.filter((i) => i.path === path);
  const err = own.find((i) => i.severity === 'error');
  const warn = own.find((i) => i.severity === 'warning');
  if (!err && !warn) return null;
  return <p className={clsx('text-xs', err ? 'text-red-600' : 'text-amber-700')}>{(err ?? warn)!.message}</p>;
}

function StudioText({ path, icon, label, placeholder, action }: { path: string; icon: IconName; label: string; placeholder?: string; action?: ReactNode }) {
  const [v, set] = useField<string>(path);
  const { readOnly, issues } = useEditor();
  return (
    <div id={fieldDomId(path)} className="space-y-1.5 rounded-md">
      <Header path={path} icon={icon} label={label} />
      <div className="relative">
        <Input value={v ?? ''} placeholder={placeholder} disabled={readOnly} aria-label={label} maxLength={120} aria-invalid={issues.some((i) => i.path === path && i.severity === 'error')} onChange={(e) => set(e.target.value)} className="pr-9" />
        {action && <span className="absolute right-2.5 top-1/2 -translate-y-1/2">{action}</span>}
      </div>
      <FieldError path={path} />
    </div>
  );
}

function StudioSelect({ path, icon, label, options }: { path: string; icon: IconName; label: string; options: Array<{ value: string; label: string }> }) {
  const [v, set] = useField<string>(path);
  const { readOnly } = useEditor();
  return (
    <div id={fieldDomId(path)} className="space-y-1.5 rounded-md">
      <Header path={path} icon={icon} label={label} />
      <Select value={v ?? ''} disabled={readOnly} aria-label={label} onChange={(e) => set(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

function StudioTextArea({ path, icon, label, rows, placeholder, expandable, mono, extra }: { path: string; icon: IconName; label: string; rows: number; placeholder?: string; expandable?: boolean; mono?: boolean; extra?: ReactNode }) {
  const [v, set] = useField<string>(path);
  const { readOnly, issues } = useEditor();
  const [expanded, setExpanded] = useState(false);
  const invalid = issues.some((i) => i.path === path && i.severity === 'error');
  return (
    <div id={fieldDomId(path)} className="space-y-1.5 rounded-md">
      <Header
        path={path}
        icon={icon}
        label={label}
        extra={
          <>
            {extra}
            {expandable && (
              <button type="button" className="flex items-center gap-1 text-xs text-brand-700 hover:underline" onClick={() => setExpanded(true)}>
                <Icon name="arrowsOut" className="h-3.5 w-3.5" /> Expand
              </button>
            )}
          </>
        }
      />
      <Textarea rows={rows} value={v ?? ''} placeholder={placeholder} disabled={readOnly} aria-label={label} aria-invalid={invalid} onChange={(e) => set(e.target.value)} className={clsx(mono && 'font-mono text-[13px] leading-relaxed')} />
      <FieldError path={path} />
      {expandable && (
        <Modal open={expanded} onClose={() => setExpanded(false)} title={label} wide footer={<Button onClick={() => setExpanded(false)}>Done</Button>}>
          <Textarea rows={26} value={v ?? ''} disabled={readOnly} aria-label={`${label} (expanded)`} onChange={(e) => set(e.target.value)} className={clsx(mono && 'font-mono text-[13px] leading-relaxed')} />
        </Modal>
      )}
    </div>
  );
}

function PlainText({ path, label, hint }: { path: string; label: string; hint?: string }) {
  const [v, set] = useField<string>(path);
  const { readOnly } = useEditor();
  return (
    <div id={fieldDomId(path)} className="space-y-1">
      <label className="block text-sm font-medium text-slate-700">
        {label}
        <Input className="mt-1" value={v ?? ''} disabled={readOnly} onChange={(e) => set(e.target.value)} />
      </label>
      {hint && <p className="text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

function QuickPrompts({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="relative">
      <button type="button" disabled={disabled} aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex items-center gap-1 text-xs text-brand-700 hover:underline disabled:text-slate-400 disabled:no-underline">
        <Icon name="bolt" className="h-3.5 w-3.5" /> Quick Prompts
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-80 rounded-md border border-slate-200 bg-white py-1 shadow-lg">
          {QUICK_PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left text-xs text-slate-700 hover:bg-slate-50"
              onClick={() => {
                setOpen(false);
                onPick(p);
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

/** How the scorer reads the rubric: who is evaluated, weighted criteria, strong/weak descriptions. */
function ProcessedRubric() {
  const { config } = useEditor();
  const r = config.rubric;
  if (!r.enabled || !config.analysis.enabled) return <p className="text-sm text-slate-600">Scoring is off for this scenario.</p>;
  if (!r.criteria.length) return <p className="text-sm text-slate-600">No criteria yet. Ask the assistant for a rubric or add criteria in Edit.</p>;
  return (
    <div className="space-y-3 text-sm text-slate-700" data-testid="rubric-processed">
      <p>
        Evaluates: <strong>{r.evaluatedSubject || 'the participant'}</strong>. Visible to {r.visibility === 'reviewers_only' ? 'reviewers only' : 'the participant and reviewers'}
        {r.passingScore !== undefined ? ` · pass mark ${r.passingScore}` : ''}.
      </p>
      <ul className="space-y-2">
        {r.criteria.map((c: RubricCriterion) => (
          <li key={c.id} className="rounded-md border border-slate-200 bg-white p-2">
            <p className="font-medium text-slate-900">
              {c.name || c.id} <span className="font-normal text-slate-500">· {c.weight}%</span>
            </p>
            {c.description && <p className="text-xs text-slate-600">{c.description}</p>}
            {c.strongPerformance && <p className="text-xs text-emerald-800">Strong: {c.strongPerformance}</p>}
            {c.weakPerformance && <p className="text-xs text-red-800">Weak: {c.weakPerformance}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
