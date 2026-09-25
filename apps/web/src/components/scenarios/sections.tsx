'use client';
import { useMemo, type ReactNode } from 'react';
import useSWR from 'swr';
import {
  EXTRACTION_TYPES,
  IDENTITY_MODES,
  LLM_PROVIDERS,
  normalizeWeights,
  PRIVACY,
  SCENARIO_TYPE_LABELS,
  SCENARIO_TYPES,
  STT_PROVIDERS,
  TOOL_CATALOG,
  TTS_PROVIDERS,
  VOICE_MODES,
  type AgendaItem,
  type ExtractionVariable,
  type RubricCriterion,
  type RuntimeVariable,
  type TimedInstruction,
  type ToolEnablement,
} from '@cf/shared';
import { ApiError } from '@/lib/api';
import { Badge, Button, Card, Checkbox, Input, Select, Textarea, clsx } from '@/components/ui';
import { fieldDomId, useEditor, useField } from './editor-context';
import {
  JsonObjectInput,
  LockButton,
  NumberField,
  SectionIssues,
  SelectField,
  StringListField,
  TagsField,
  TextAreaField,
  TextField,
  ToggleField,
  newId,
  toKey,
  toSlugId,
} from './fields';

export function Group({ title, path, description, children, id }: { title: ReactNode; path?: string; description?: ReactNode; children: ReactNode; id?: string }) {
  return (
    <Card
      className="scroll-mt-24"
      title={
        <span id={id} className="flex items-center gap-2">
          {title}
        </span>
      }
      actions={path ? <LockButton path={path} /> : undefined}
    >
      <div id={path ? fieldDomId(path) : undefined} className="space-y-4">
        {description && <p className="text-xs text-slate-500">{description}</p>}
        {children}
        {path && <SectionIssues path={path} />}
      </div>
    </Card>
  );
}

const grid = 'grid gap-4 sm:grid-cols-2';

// ───────────────────────────── Basics ─────────────────────────────

export function BasicsSection() {
  return (
    <Group title="Basics" id="sec-basics">
      <div className={grid}>
        <TextField path="basics.name" label="Name" required maxLength={120} />
        <SelectField path="basics.type" label="Type" options={SCENARIO_TYPES.map((t) => ({ value: t, label: SCENARIO_TYPE_LABELS[t] }))} />
      </div>
      <TextAreaField path="basics.publicDescription" label="Public description" required rows={2} hint="Shown in the gallery and before a participant starts." />
      <TextAreaField path="basics.participantInstructions" label="Participant instructions" required rows={3} hint="What participants should do. {{variables}} from the allowlist are substituted." />
      <TextAreaField path="basics.internalDescription" label="Internal description" rows={2} hint="Only visible to creators in this workspace." />
      <div className={grid}>
        <TextField path="basics.language" label="Language" hint="BCP-47, e.g. en-US" />
        <NumberField path="basics.targetDurationMinutes" label="Target duration (minutes)" min={1} max={240} />
        <SelectField
          path="basics.privacy"
          label="Privacy"
          options={PRIVACY.map((p) => ({ value: p, label: p === 'PRIVATE' ? 'Private (grants & links only)' : p === 'ORGANIZATION' ? 'Organization (all members)' : 'Public (anyone, rate-limited)' }))}
        />
        <TagsField path="basics.tags" label="Tags" />
      </div>
    </Group>
  );
}

// ───────────────────────────── Persona & instructions ─────────────────────────────

export function PersonaSection({ advanced = true }: { advanced?: boolean }) {
  return (
    <Group title="AI persona" id="sec-persona">
      <div className={grid}>
        <TextField path="persona.role" label="Role the AI plays" required placeholder="e.g. Hiring manager at a fintech startup" />
        <TextField path="persona.name" label="Persona name" placeholder="e.g. Alex" />
      </div>
      <TextAreaField path="persona.description" label="Persona description" rows={4} hint="Personality, background, hidden facts, how they react. Your words are kept verbatim." />
      {advanced && (
        <>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Voice</h3>
            <LockButton path="persona.voice" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3" id={fieldDomId('persona.voice')}>
            <SelectField path="persona.voice.provider" label="Voice provider" options={['browser', 'openai', 'elevenlabs']} />
            <TextField path="persona.voice.voiceId" label="Voice id" placeholder="provider default" />
            <NumberField path="persona.voice.speed" label="Speed" min={0.5} max={2} step={0.05} />
          </div>
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-800">Avatar</h3>
            <LockButton path="persona.avatar" />
          </div>
          <div className="grid gap-4 sm:grid-cols-3" id={fieldDomId('persona.avatar')}>
            <SelectField path="persona.avatar.kind" label="Avatar" options={['none', 'initials', 'image']} />
            <OptionalText path="persona.avatar.imageUrl" label="Image URL" placeholder="https://…" />
            <OptionalText path="persona.avatar.accentColor" label="Accent color" placeholder="#4f46e5" />
          </div>
        </>
      )}
    </Group>
  );
}

function OptionalText({ path, label, placeholder }: { path: string; label: string; placeholder?: string }) {
  const [v, set] = useField<string | undefined>(path);
  const { readOnly } = useEditor();
  return (
    <div className="space-y-1" id={fieldDomId(path)}>
      <label className="block text-sm font-medium text-slate-700">
        {label}
        <Input className="mt-1" value={v ?? ''} placeholder={placeholder} disabled={readOnly} onChange={(e) => set(e.target.value.trim() ? e.target.value : undefined)} />
      </label>
    </div>
  );
}

export function InstructionsSection({ advanced = true }: { advanced?: boolean }) {
  return (
    <Group title="Instructions & goals" id="sec-instructions">
      <StringListField path="instructions.goals" label="Goals" required placeholder="What should this conversation achieve?" addLabel="Add goal" />
      <TextAreaField path="instructions.aiInstructions" label="AI instructions" rows={6} hint="How the AI should behave. Prose is preserved verbatim." />
      <StringListField path="instructions.boundaries" label="Boundaries" placeholder="Something the AI must never do" addLabel="Add boundary" />
      {advanced && (
        <div className={grid}>
          <TextField path="instructions.tone" label="Tone" />
          <SelectField path="instructions.verbosity" label="Verbosity" options={['concise', 'balanced', 'detailed']} hint="Concise works best for voice." />
        </div>
      )}
    </Group>
  );
}

// ───────────────────────────── Conversation ─────────────────────────────

export function ConversationSection() {
  return (
    <Group title="Conversation" id="sec-conversation">
      <SelectField
        path="conversation.strategy"
        label="Strategy"
        options={[
          { value: 'adaptive', label: 'Adaptive — agenda is a guide; follow-ups from answers' },
          { value: 'fixed_questions', label: 'Fixed questions — ask each question verbatim' },
          { value: 'hybrid', label: 'Hybrid — fixed where given, adaptive elsewhere' },
        ]}
      />
      <FirstTurnEditor />
      <AgendaEditor />
    </Group>
  );
}

export function FirstTurnEditor() {
  return (
    <div className="space-y-3 rounded-md border border-slate-200 p-3" id={fieldDomId('conversation.firstTurn')}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">First turn</h3>
        <LockButton path="conversation.firstTurn" />
      </div>
      <SelectField path="conversation.firstTurn.speaker" label="Who speaks first" options={[{ value: 'agent', label: 'The AI' }, { value: 'participant', label: 'The participant' }]} />
      <TextAreaField path="conversation.firstTurn.text" label="Opening line" rows={2} hint="Used when the AI speaks first. Supports {{variables}}." />
    </div>
  );
}

export function AgendaEditor() {
  const [agenda, setAgenda] = useField<AgendaItem[]>('conversation.agenda');
  const [strategy] = useField<string>('conversation.strategy');
  const { readOnly } = useEditor();
  const items = agenda ?? [];
  const update = (i: number, patch: Partial<AgendaItem>) => setAgenda(items.map((a, j) => (j === i ? { ...a, ...patch } : a)));
  const move = (i: number, d: number) => {
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    const next = [...items];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setAgenda(next);
  };
  return (
    <div className="space-y-3" id={fieldDomId('conversation.agenda')}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-800">Agenda ({items.length})</h3>
        <LockButton path="conversation.agenda" />
      </div>
      {items.map((a, i) => (
        <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3" id={fieldDomId(`conversation.agenda.${i}`)}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-slate-500">#{i + 1}</span>
            <Input aria-label={`Topic ${i + 1}`} className="flex-1" value={a.topic} placeholder="Topic" disabled={readOnly} onChange={(e) => update(i, { topic: e.target.value })} />
            <Button variant="ghost" size="sm" aria-label="Move up" disabled={readOnly || i === 0} onClick={() => move(i, -1)}>
              ↑
            </Button>
            <Button variant="ghost" size="sm" aria-label="Move down" disabled={readOnly || i === items.length - 1} onClick={() => move(i, 1)}>
              ↓
            </Button>
            <Button variant="ghost" size="sm" aria-label="Remove topic" disabled={readOnly} onClick={() => setAgenda(items.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </div>
          <Textarea aria-label={`Guidance ${i + 1}`} rows={2} value={a.guidance} placeholder="Guidance: what a good answer covers, what to probe" disabled={readOnly} onChange={(e) => update(i, { guidance: e.target.value })} />
          {strategy !== 'adaptive' && (
            <div id={fieldDomId(`conversation.agenda.${i}.fixedQuestion`)}>
              <Input aria-label={`Fixed question ${i + 1}`} value={a.fixedQuestion ?? ''} placeholder="Fixed question (asked verbatim)" disabled={readOnly} onChange={(e) => update(i, { fixedQuestion: e.target.value || undefined })} />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <Checkbox label="Required" checked={a.required} disabled={readOnly} onChange={(v) => update(i, { required: v })} />
            <label className="flex items-center gap-2 text-slate-700">
              Max follow-ups
              <Input type="number" min={0} max={10} className="w-20" value={a.maxFollowUps} disabled={readOnly} onChange={(e) => update(i, { maxFollowUps: Math.max(0, Math.min(10, Number(e.target.value) || 0)) })} />
            </label>
            <label className="flex items-center gap-2 text-slate-700">
              Id
              <Input className="w-36 font-mono text-xs" value={a.id} disabled={readOnly} onChange={(e) => update(i, { id: toSlugId(e.target.value) || a.id })} />
            </label>
          </div>
        </div>
      ))}
      <Button
        variant="secondary"
        size="sm"
        disabled={readOnly}
        onClick={() => setAgenda([...items, { id: newId('topic', items.map((a) => a.id)), topic: '', guidance: '', required: true, maxFollowUps: 2 }])}
      >
        + Add topic
      </Button>
    </div>
  );
}

export function TurnTakingSection() {
  return (
    <Group title="Turn-taking" path="conversation.turnTaking" description="Pauses are not interrupted by default: the agent waits while the participant thinks.">
      <div className={grid}>
        <SelectField path="conversation.turnTaking.mode" label="Mode" options={[{ value: 'vad', label: 'Automatic (voice activity)' }, { value: 'push_to_talk', label: 'Push to talk' }]} />
        <NumberField path="conversation.turnTaking.endOfTurnSilenceMs" label="End-of-turn silence (ms)" min={300} max={5000} step={100} />
        <NumberField path="conversation.turnTaking.thinkingPauseGraceMs" label="Thinking pause grace (ms)" min={0} max={60000} step={1000} />
        <NumberField path="conversation.turnTaking.silenceCheckInMs" label="Silence check-in after (ms, 0 = never)" min={0} max={120000} step={1000} />
      </div>
      <ToggleField path="conversation.turnTaking.allowBargeIn" label="Allow barge-in (participant can interrupt the AI)" />
    </Group>
  );
}

export function TimedInstructionsSection() {
  const [items = [], set] = useField<TimedInstruction[]>('conversation.timedInstructions');
  const { readOnly } = useEditor();
  const update = (i: number, patch: Partial<TimedInstruction>) => set(items.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  return (
    <Group title="Timed instructions" path="conversation.timedInstructions" description="Delivered to the AI at a point in time (never shown to the participant).">
      {items.map((t, i) => (
        <div key={i} className="flex flex-wrap items-start gap-2 rounded-md border border-slate-200 p-2" id={fieldDomId(`conversation.timedInstructions.${i}`)}>
          <label className="text-xs text-slate-600">
            At (min)
            <Input type="number" min={0} step={0.5} className="w-20" value={t.atSecond / 60} disabled={readOnly} onChange={(e) => update(i, { atSecond: Math.max(0, Math.round((Number(e.target.value) || 0) * 60)) })} />
          </label>
          <label className="text-xs text-slate-600">
            Action
            <Select value={t.action} disabled={readOnly} onChange={(e) => update(i, { action: e.target.value as TimedInstruction['action'] })}>
              <option value="nudge">Nudge</option>
              <option value="wrap_up">Wrap up</option>
              <option value="end">End</option>
            </Select>
          </label>
          <label className="min-w-[12rem] flex-1 text-xs text-slate-600">
            Instruction
            <Input value={t.instruction} disabled={readOnly} onChange={(e) => update(i, { instruction: e.target.value })} />
          </label>
          <Button variant="ghost" size="sm" aria-label="Remove" disabled={readOnly} onClick={() => set(items.filter((_, j) => j !== i))}>
            ✕
          </Button>
        </div>
      ))}
      <Button variant="secondary" size="sm" disabled={readOnly} onClick={() => set([...items, { id: newId('t', items.map((x) => x.id)), atSecond: 300, action: 'nudge', instruction: '' }])}>
        + Add timed instruction
      </Button>
    </Group>
  );
}

export function EndingSection() {
  return (
    <Group title="Ending & timing" path="conversation.ending">
      <TextAreaField path="conversation.ending.closingMessage" label="Closing message" rows={2} />
      <div className={grid}>
        <NumberField path="conversation.ending.maxDurationMinutes" label="Maximum duration (minutes)" min={1} max={240} />
        <NumberField path="conversation.ending.wrapUpLeadMinutes" label="Wrap-up warning before the cap (minutes)" min={0} max={30} />
      </div>
      <ToggleField path="conversation.ending.endWhenAgendaComplete" label="Close when all required agenda topics are covered" />
      <ToggleField path="conversation.ending.allowParticipantEnd" label="Participant may end the session" />
    </Group>
  );
}

// ───────────────────────────── Model / audio / recording / analysis ─────────────────────────────

export function ModelSection() {
  return (
    <Group title="Model & providers" path="model" description="Real providers are used when configured in Settings → AI providers; otherwise the clearly-labeled local simulator runs.">
      <div className={grid}>
        <SelectField path="model.voiceMode" label="Voice mode" options={VOICE_MODES.map((v) => ({ value: v, label: v === 'pipeline' ? 'Pipeline (STT → LLM → TTS)' : 'Realtime (speech-to-speech)' }))} />
        <SelectField path="model.llmProvider" label="LLM provider" options={LLM_PROVIDERS} />
        <TextField path="model.llmModel" label="LLM model" placeholder="workspace default" />
        <NumberField path="model.temperature" label="Temperature" min={0} max={1.5} step={0.1} hint="Ignored by models that do not support it." />
        <SelectField path="model.sttProvider" label="Speech-to-text" options={STT_PROVIDERS} />
        <SelectField path="model.ttsProvider" label="Text-to-speech" options={TTS_PROVIDERS} />
        <TextField path="model.realtimeModel" label="Realtime model" placeholder="default" />
      </div>
    </Group>
  );
}

export function AudioSection() {
  return (
    <Group title="Audio controls" path="audio">
      <div className={grid}>
        <ToggleField path="audio.echoCancellation" label="Echo cancellation" />
        <ToggleField path="audio.noiseSuppression" label="Noise suppression" />
        <ToggleField path="audio.autoGainControl" label="Auto gain control" />
        <ToggleField path="audio.allowCamera" label="Allow camera" />
      </div>
    </Group>
  );
}

export function RecordingSection() {
  return (
    <Group title="Recording & consent" path="recording" description="Participants always consent before recording or analysis starts.">
      <div className={grid}>
        <ToggleField path="recording.audio" label="Record audio" />
        <ToggleField path="recording.video" label="Record video" />
      </div>
      <TextAreaField path="recording.consentNotice" label="Consent notice" rows={2} hint="Leave empty to use a generated notice (see Preview)." />
      <NumberField path="recording.retentionDays" label="Retention (days)" min={1} max={3650} />
    </Group>
  );
}

export function AnalysisSection() {
  return (
    <Group title="Analysis & visibility" path="analysis">
      <ToggleField path="analysis.enabled" label="Analyze sessions (feedback, scores, extraction)" />
      <div className={grid}>
        <ToggleField path="analysis.participantCanSeeTranscript" label="Participant can see the transcript" />
        <ToggleField path="analysis.participantCanSeeFeedback" label="Participant can see feedback" />
        <ToggleField path="analysis.participantCanSeeScores" label="Participant can see scores" />
        <ToggleField path="analysis.requireHumanReview" label="Require human review" description="Recommended for hiring/assessment." />
        <ToggleField path="analysis.notifyOnComplete" label="Notify reviewers when analysis completes" />
      </div>
    </Group>
  );
}

// ───────────────────────────── Rubric ─────────────────────────────

export function RubricSection() {
  const [criteria = [], setCriteria] = useField<RubricCriterion[]>('rubric.criteria');
  const [enabled] = useField<boolean>('rubric.enabled');
  const { readOnly } = useEditor();
  const sum = criteria.reduce((s, c) => s + (Number(c.weight) || 0), 0);
  const ok = Math.abs(sum - 100) <= 0.01;
  const update = (i: number, patch: Partial<RubricCriterion>) => setCriteria(criteria.map((c, j) => (j === i ? { ...c, ...patch } : c)));
  return (
    <Group title="Feedback rubric" path="rubric" description="The model judges each criterion with transcript evidence; weighting happens in code.">
      <ToggleField path="rubric.enabled" label="Score with a rubric" />
      {enabled && (
        <>
          <div className={grid}>
            <TextField path="rubric.evaluatedSubject" label="Who is evaluated" />
            <NumberField path="rubric.passingScore" label="Passing score (optional)" min={0} max={100} optional />
            <NumberField path="rubric.minEvidenceCoverage" label="Minimum evidence coverage (0–1)" min={0} max={1} step={0.05} />
            <SelectField path="rubric.visibility" label="Scores visible to" options={[{ value: 'reviewers_only', label: 'Reviewers only' }, { value: 'participant_and_reviewers', label: 'Participant and reviewers' }]} />
          </div>
          <div id={fieldDomId('rubric.criteria')} className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold text-slate-800">Criteria</h3>
              <div className="flex items-center gap-2">
                <Badge tone={ok ? 'green' : 'red'}>Weights: {Math.round(sum * 100) / 100} / 100</Badge>
                <Button variant="secondary" size="sm" disabled={readOnly || !criteria.length || ok} onClick={() => setCriteria(normalizeWeights(criteria))}>
                  Normalize to 100
                </Button>
              </div>
            </div>
            {criteria.map((c, i) => (
              <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3" id={fieldDomId(`rubric.criteria.${i}`)}>
                <div className="flex flex-wrap items-center gap-2">
                  <Input aria-label={`Criterion ${i + 1} name`} className="min-w-[10rem] flex-1" value={c.name} placeholder="Criterion name" disabled={readOnly} onChange={(e) => update(i, { name: e.target.value })} />
                  <label className="flex items-center gap-1 text-sm text-slate-600" id={fieldDomId(`rubric.criteria.${i}.weight`)}>
                    Weight
                    <Input aria-label={`Criterion ${i + 1} weight`} type="number" min={0} max={100} className="w-20" value={c.weight} disabled={readOnly} onChange={(e) => update(i, { weight: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
                  </label>
                  <Button variant="ghost" size="sm" aria-label="Remove criterion" disabled={readOnly} onClick={() => setCriteria(criteria.filter((_, j) => j !== i))}>
                    ✕
                  </Button>
                </div>
                <Textarea aria-label={`Criterion ${i + 1} description`} rows={2} value={c.description} placeholder="What is assessed" disabled={readOnly} onChange={(e) => update(i, { description: e.target.value })} />
                <div className="grid gap-2 sm:grid-cols-2">
                  <Textarea aria-label={`Criterion ${i + 1} strong performance`} rows={2} value={c.strongPerformance} placeholder="Strong performance looks like…" disabled={readOnly} onChange={(e) => update(i, { strongPerformance: e.target.value })} />
                  <Textarea aria-label={`Criterion ${i + 1} weak performance`} rows={2} value={c.weakPerformance} placeholder="Weak performance looks like…" disabled={readOnly} onChange={(e) => update(i, { weakPerformance: e.target.value })} />
                </div>
              </div>
            ))}
            <Button
              variant="secondary"
              size="sm"
              disabled={readOnly}
              onClick={() => setCriteria([...criteria, { id: newId('criterion', criteria.map((c) => c.id)), name: '', description: '', weight: criteria.length ? 0 : 100, strongPerformance: '', weakPerformance: '' }])}
            >
              + Add criterion
            </Button>
          </div>
        </>
      )}
    </Group>
  );
}

// ───────────────────────────── Extraction & variables ─────────────────────────────

export function ExtractionSection() {
  const [vars = [], set] = useField<ExtractionVariable[]>('extraction.variables');
  const { readOnly } = useEditor();
  const update = (i: number, patch: Partial<ExtractionVariable>) => set(vars.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <Group title="Data to extract" path="extraction.variables" description="Structured values pulled from each transcript after the session.">
      {vars.map((v, i) => (
        <div key={i} className="space-y-2 rounded-md border border-slate-200 p-3" id={fieldDomId(`extraction.variables.${i}`)}>
          <div className="flex flex-wrap items-center gap-2">
            <Input aria-label={`Extraction key ${i + 1}`} className="w-48 font-mono text-xs" value={v.key} placeholder="snake_case_key" disabled={readOnly} onChange={(e) => update(i, { key: toKey(e.target.value) })} />
            <Select aria-label={`Extraction type ${i + 1}`} className="w-32" value={v.type} disabled={readOnly} onChange={(e) => update(i, { type: e.target.value as ExtractionVariable['type'] })}>
              {EXTRACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
            <Checkbox label="Required" checked={v.required} disabled={readOnly} onChange={(x) => update(i, { required: x })} />
            <Button variant="ghost" size="sm" aria-label="Remove variable" disabled={readOnly} onClick={() => set(vars.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </div>
          <Input aria-label={`Extraction description ${i + 1}`} value={v.description} placeholder="What to extract" disabled={readOnly} onChange={(e) => update(i, { description: e.target.value })} />
          {(v.type === 'text' || v.type === 'list') && (
            <Input
              aria-label={`Allowed values ${i + 1}`}
              value={(v.enumValues ?? []).join(', ')}
              placeholder="Allowed values (optional, comma separated)"
              disabled={readOnly}
              onChange={(e) => {
                const list = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
                update(i, { enumValues: list.length ? list : undefined });
              }}
            />
          )}
        </div>
      ))}
      <Button variant="secondary" size="sm" disabled={readOnly} onClick={() => set([...vars, { key: `field_${vars.length + 1}`, description: '', type: 'text', required: false }])}>
        + Add variable
      </Button>
    </Group>
  );
}

export function VariablesSection() {
  const [vars = [], set] = useField<RuntimeVariable[]>('variables.allowlist');
  const { readOnly } = useEditor();
  const update = (i: number, patch: Partial<RuntimeVariable>) => set(vars.map((v, j) => (j === i ? { ...v, ...patch } : v)));
  return (
    <Group title="Runtime variables" path="variables.allowlist" description="Only these keys may be used as {{placeholders}}. Values from links/embeds/API are sanitized and treated as data.">
      {vars.map((v, i) => (
        <div key={i} className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-6" id={fieldDomId(`variables.allowlist.${i}`)}>
          <Input aria-label={`Variable key ${i + 1}`} className="font-mono text-xs sm:col-span-2" value={v.key} placeholder="key" disabled={readOnly} onChange={(e) => update(i, { key: toKey(e.target.value) })} />
          <Input aria-label={`Variable label ${i + 1}`} className="sm:col-span-2" value={v.label} placeholder="Label" disabled={readOnly} onChange={(e) => update(i, { label: e.target.value })} />
          <Input aria-label={`Variable max length ${i + 1}`} type="number" min={1} max={2000} value={v.maxLength} disabled={readOnly} onChange={(e) => update(i, { maxLength: Math.max(1, Math.min(2000, Number(e.target.value) || 1)) })} />
          <div className="flex items-center gap-2">
            <Checkbox label="Req." checked={v.required} disabled={readOnly} onChange={(x) => update(i, { required: x })} />
            <Button variant="ghost" size="sm" aria-label="Remove variable" disabled={readOnly} onClick={() => set(vars.filter((_, j) => j !== i))}>
              ✕
            </Button>
          </div>
          <Input aria-label={`Variable default ${i + 1}`} className="sm:col-span-3" value={v.defaultValue ?? ''} placeholder="Default value (optional)" disabled={readOnly} onChange={(e) => update(i, { defaultValue: e.target.value || undefined })} />
          <Input aria-label={`Variable pattern ${i + 1}`} className="font-mono text-xs sm:col-span-3" id={fieldDomId(`variables.allowlist.${i}.pattern`)} value={v.pattern ?? ''} placeholder="Pattern (optional regex)" disabled={readOnly} onChange={(e) => update(i, { pattern: e.target.value || undefined })} />
        </div>
      ))}
      <Button variant="secondary" size="sm" disabled={readOnly} onClick={() => set([...vars, { key: `var_${vars.length + 1}`, label: '', description: '', required: false, maxLength: 200 }])}>
        + Add variable
      </Button>
    </Group>
  );
}

// ───────────────────────────── Memory & coach ─────────────────────────────

export function MemoryCoachSection() {
  const [phases = [], setPhases] = useField<string[]>('coach.phases');
  const { readOnly } = useEditor();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Group title="Learner memory" path="memory" description="Remembers facts about each learner across sessions (scoped to the learner; they can opt out).">
        <ToggleField path="memory.enabled" label="Enable memory" />
        <NumberField path="memory.maxFactsInPrompt" label="Max facts in prompt" min={0} max={50} />
        <ToggleField path="memory.learnFromSessions" label="Learn new facts after sessions" />
      </Group>
      <Group title="Coach mode" path="coach">
        <ToggleField path="coach.enabled" label="Enable coach mode" />
        <TextField path="coach.focusSkill" label="Focus skill" />
        <div className="flex flex-wrap gap-4">
          {(['teach', 'practice', 'feedback'] as const).map((p) => (
            <Checkbox key={p} label={p} checked={phases.includes(p)} disabled={readOnly} onChange={(v) => setPhases(v ? (['teach', 'practice', 'feedback'] as const).filter((x) => x === p || phases.includes(x)) : phases.filter((x) => x !== p))} />
          ))}
        </div>
      </Group>
    </div>
  );
}

// ───────────────────────────── Tools, knowledge, functions ─────────────────────────────

export function ToolsSection() {
  const [enabled = [], set] = useField<ToolEnablement[]>('tools.enabled');
  const { readOnly } = useEditor();
  const byId = new Map(enabled.map((t) => [t.toolId, t]));
  const upsert = (toolId: string, patch: Partial<ToolEnablement>) => {
    const cur = byId.get(toolId);
    if (cur) set(enabled.map((t) => (t.toolId === toolId ? { ...t, ...patch } : t)));
    else set([...enabled, { toolId, enabled: true, config: {}, usageHint: '', ...patch }]);
  };
  return (
    <Group title="Tools" path="tools">
      <ul className="divide-y divide-slate-100">
        {TOOL_CATALOG.map((def) => {
          const cur = byId.get(def.id);
          const on = !!cur?.enabled;
          const planned = def.status === 'planned';
          return (
            <li key={def.id} className="py-3" id={fieldDomId(`tools.enabled.${enabled.findIndex((t) => t.toolId === def.id)}`)}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <Checkbox
                  label={
                    <span>
                      <span className="font-medium">{def.name}</span> {planned && <Badge tone="gray">Coming soon</Badge>}
                    </span>
                  }
                  description={def.description}
                  checked={on}
                  disabled={readOnly || (planned && !on)}
                  onChange={(v) => upsert(def.id, { enabled: v })}
                />
              </div>
              {on && (
                <div className="mt-2 grid gap-2 pl-6 sm:grid-cols-2">
                  <label className="text-xs text-slate-600">
                    Usage hint
                    <Input value={cur?.usageHint ?? ''} placeholder={def.defaultUsageHint} disabled={readOnly} onChange={(e) => upsert(def.id, { usageHint: e.target.value })} />
                  </label>
                  <div className="text-xs text-slate-600">
                    Config (JSON)
                    <JsonObjectInput label={`${def.name} config`} value={cur?.config ?? {}} disabled={readOnly} onChange={(c) => upsert(def.id, { config: c })} />
                  </div>
                </div>
              )}
            </li>
          );
        })}
        {enabled
          .filter((t) => !TOOL_CATALOG.some((d) => d.id === t.toolId))
          .map((t) => (
            <li key={t.toolId} className="flex items-center justify-between py-2 text-sm text-red-700">
              Unknown tool “{t.toolId}”
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => set(enabled.filter((x) => x.toolId !== t.toolId))}>
                Remove
              </Button>
            </li>
          ))}
      </ul>
      <CustomFunctionsPicker />
    </Group>
  );
}

function useOptionalList<T>(key: string | null) {
  const { data, error } = useSWR<{ data: T[] }>(key, { shouldRetryOnError: false });
  const status = error instanceof ApiError ? error.status : error ? 500 : null;
  return { items: data?.data ?? [], loading: !data && !error, unavailable: status === 404 ? 'missing' : status === 403 ? 'forbidden' : status ? 'error' : null };
}

function MultiPicker({
  label,
  path,
  options,
  unavailable,
  emptyText,
}: {
  label: string;
  path: string;
  options: Array<{ id: string; label: string; sub?: string }>;
  unavailable: string | null;
  emptyText: string;
}) {
  const [ids = [], set] = useField<string[]>(path);
  const { readOnly, issues } = useEditor();
  const known = new Set(options.map((o) => o.id));
  const orphans = ids.filter((id) => !known.has(id));
  return (
    <div className="space-y-2" id={fieldDomId(path)}>
      <h3 className="text-sm font-semibold text-slate-800">{label}</h3>
      {unavailable === 'missing' && <p className="text-xs text-slate-500">This list is not available yet.</p>}
      {unavailable === 'forbidden' && <p className="text-xs text-slate-500">Your role cannot list these; ask an admin. Existing selections are kept.</p>}
      {unavailable === 'error' && <p className="text-xs text-red-600">Could not load the list.</p>}
      {!unavailable && !options.length && <p className="text-xs text-slate-500">{emptyText}</p>}
      <ul className="space-y-1">
        {options.map((o) => (
          <li key={o.id}>
            <Checkbox label={o.label} description={o.sub} checked={ids.includes(o.id)} disabled={readOnly} onChange={(v) => set(v ? [...ids, o.id] : ids.filter((x) => x !== o.id))} />
          </li>
        ))}
        {orphans.map((id) => {
          const idx = ids.indexOf(id);
          const issue = issues.find((i) => i.path === `${path}.${idx}`);
          return (
            <li key={id} className="flex items-center justify-between text-xs" id={fieldDomId(`${path}.${idx}`)}>
              <span className={clsx('font-mono', issue?.severity === 'error' ? 'text-red-700' : 'text-slate-600')}>
                {id} {issue ? `— ${issue.message}` : ''}
              </span>
              <Button variant="ghost" size="sm" disabled={readOnly} onClick={() => set(ids.filter((x) => x !== id))}>
                Remove
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function CustomFunctionsPicker() {
  const { workspaceId } = useEditor();
  const { items, unavailable } = useOptionalList<{ id: string; name: string; description?: string; enabled?: boolean }>(`/workspaces/${workspaceId}/functions`);
  const options = useMemo(() => items.map((f) => ({ id: f.id, label: f.name, sub: `${f.description ?? ''}${f.enabled === false ? ' (disabled)' : ''}` })), [items]);
  return <MultiPicker label="Custom functions" path="tools.customFunctionIds" options={options} unavailable={unavailable} emptyText="No custom functions in this workspace (Settings → Functions)." />;
}

export function KnowledgeSection() {
  const { workspaceId } = useEditor();
  const { items, unavailable } = useOptionalList<{ id: string; title: string; status: string }>(`/workspaces/${workspaceId}/knowledge/documents?limit=200`);
  const options = useMemo(() => items.map((d) => ({ id: d.id, label: d.title, sub: d.status === 'COMPLETED' ? undefined : d.status.toLowerCase() })), [items]);
  return (
    <Group title="Knowledge" path="knowledge" description="Documents the agent can search. Excerpts are reference data, never instructions.">
      <MultiPicker label="Documents" path="knowledge.documentIds" options={options} unavailable={unavailable} emptyText="No documents yet — upload them under Knowledge." />
      <div className={grid}>
        <NumberField path="knowledge.topK" label="Excerpts per search" min={1} max={10} />
        <ToggleField path="knowledge.autoRetrieve" label="Search automatically on each participant turn" />
      </div>
    </Group>
  );
}

// ───────────────────────────── Channels & access ─────────────────────────────

export function ChannelsSection() {
  return (
    <Group title="Channels" path="channels">
      <div className={grid}>
        <ToggleField path="channels.browser.enabled" label="Browser" />
        <ToggleField path="channels.browser.allowTextFallback" label="Allow typing instead of speaking" />
        <ToggleField path="channels.browser.showCaptions" label="Show captions" />
        <ToggleField path="channels.browser.showArtifactPanel" label="Show tool panel" />
        <ToggleField path="channels.embed.enabled" label="Embeddable widget" />
        <ToggleField path="channels.meeting.enabled" label="Meeting bot" />
        <ToggleField path="channels.phone.enabled" label="Phone" />
      </div>
      <OptionalText path="channels.phone.greetingOverride" label="Phone greeting override" />
      <OptionalText path="channels.phone.transferNumber" label="Phone transfer number" placeholder="+15551234567" />
    </Group>
  );
}

export function AccessSection() {
  return (
    <Group title="Access defaults" path="access" description="Defaults for new share links. Manage links and grants under Share & access.">
      <div className={grid}>
        <SelectField path="access.identityMode" label="Ask participants for" options={IDENTITY_MODES.map((m) => ({ value: m, label: { NONE: 'Nothing (anonymous)', NAME: 'Name', EMAIL: 'Email', NAME_EMAIL: 'Name and email' }[m] }))} />
        <NumberField path="access.defaultAttemptLimitPerEmail" label="Attempt limit per email (optional)" min={1} max={1000} optional />
      </div>
    </Group>
  );
}
