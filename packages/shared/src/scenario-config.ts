import { z } from 'zod';
import { SCENARIO_TYPES, PRIVACY, IDENTITY_MODES } from './enums';
import { regexPatternRisk } from './safe-regex';

/**
 * ScenarioConfig is the single source of truth for a scenario's behavior.
 * - Drafts store a (possibly incomplete) ScenarioConfig.
 * - Publishing validates it, normalizes it (defaults, ids, trimmed whitespace — prose is preserved verbatim
 *   apart from leading/trailing whitespace), and freezes it into an immutable ScenarioVersion.
 * It is plain data: YAML/JSON import is parsed as data only; nothing in here is ever executed.
 */

export const SCHEMA_VERSION = 1;

const id = () => z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/, 'Use letters, numbers, - or _');
const prose = (max = 20000) => z.string().max(max);
const shortText = (max = 300) => z.string().max(max);

export const VARIABLE_KEY_RE = /^[a-z][a-z0-9_]{0,47}$/;

export const AgendaItemSchema = z.object({
  id: id(),
  topic: shortText(200),
  /** Guidance for the agent: what a good answer covers, what to probe. */
  guidance: prose(4000).default(''),
  /** Required topics must be covered before the agent starts closing (unless capped by time). */
  required: z.boolean().default(true),
  /** If set and strategy is fixed/hybrid, the agent asks this exact question. */
  fixedQuestion: prose(1000).optional(),
  /** Maximum follow-up questions on this topic before moving on. */
  maxFollowUps: z.number().int().min(0).max(10).default(2),
});
export type AgendaItem = z.infer<typeof AgendaItemSchema>;

export const TimedInstructionSchema = z.object({
  id: id(),
  /** Seconds since the session became ACTIVE. */
  atSecond: z.number().int().min(0).max(4 * 3600),
  action: z.enum(['nudge', 'wrap_up', 'end']),
  /** Instruction delivered to the agent at that time (never shown to the participant verbatim). */
  instruction: prose(2000).default(''),
});
export type TimedInstruction = z.infer<typeof TimedInstructionSchema>;

export const RubricCriterionSchema = z.object({
  id: id(),
  name: shortText(120),
  description: prose(4000).default(''),
  /** Relative weight in percent; all weights must sum to 100 to publish. */
  weight: z.number().min(0).max(100),
  strongPerformance: prose(4000).default(''),
  weakPerformance: prose(4000).default(''),
});
export type RubricCriterion = z.infer<typeof RubricCriterionSchema>;

export const RubricSchema = z.object({
  enabled: z.boolean().default(true),
  /** Who or what is evaluated, e.g. "the participant (candidate)". */
  evaluatedSubject: shortText(200).default('the participant'),
  criteria: z.array(RubricCriterionSchema).max(25).default([]),
  /** Optional pass mark on the 0-100 overall score. */
  passingScore: z.number().min(0).max(100).optional(),
  /** Minimum share of total weight (0-1) that needs evidence before an overall score is shown. */
  minEvidenceCoverage: z.number().min(0).max(1).default(0.6),
  visibility: z.enum(['reviewers_only', 'participant_and_reviewers']).default('reviewers_only'),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const EXTRACTION_TYPES = ['text', 'number', 'boolean', 'list', 'date'] as const;
export type ExtractionType = (typeof EXTRACTION_TYPES)[number];

export const ExtractionVariableSchema = z.object({
  key: z.string().regex(VARIABLE_KEY_RE, 'Use snake_case starting with a letter (max 48 chars)'),
  description: prose(2000).default(''),
  type: z.enum(EXTRACTION_TYPES),
  required: z.boolean().default(false),
  /** Optional allowed values for text/list types. */
  enumValues: z.array(shortText(200)).max(50).optional(),
});
export type ExtractionVariable = z.infer<typeof ExtractionVariableSchema>;

export const RuntimeVariableSchema = z.object({
  key: z.string().regex(VARIABLE_KEY_RE, 'Use snake_case starting with a letter (max 48 chars)'),
  label: shortText(120).default(''),
  description: prose(1000).default(''),
  required: z.boolean().default(false),
  maxLength: z.number().int().min(1).max(2000).default(200),
  /** Optional constraint (JS regex source, anchored automatically). Evaluated as data, with a length cap. */
  pattern: z.string().max(200).optional(),
  defaultValue: shortText(2000).optional(),
});
export type RuntimeVariable = z.infer<typeof RuntimeVariableSchema>;

export const ToolEnablementSchema = z.object({
  toolId: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** Tool-specific configuration, validated by the tool registry's own schema. */
  config: z.record(z.unknown()).default({}),
  /** Hint to the agent on when to use it. */
  usageHint: prose(1000).default(''),
});
export type ToolEnablement = z.infer<typeof ToolEnablementSchema>;

export const LLM_PROVIDERS = ['anthropic', 'openai', 'simulator'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];
export const VOICE_MODES = ['pipeline', 'realtime'] as const;
export type VoiceMode = (typeof VOICE_MODES)[number];
export const STT_PROVIDERS = ['browser', 'openai', 'deepgram', 'typed'] as const;
export type SttProviderId = (typeof STT_PROVIDERS)[number];
export const TTS_PROVIDERS = ['browser', 'openai', 'elevenlabs', 'none'] as const;
export type TtsProviderId = (typeof TTS_PROVIDERS)[number];
export const REALTIME_PROVIDERS = ['openai'] as const;

export const ScenarioConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION).default(SCHEMA_VERSION),

  basics: z
    .object({
      name: shortText(120).default(''),
      type: z.enum(SCENARIO_TYPES).default('custom'),
      internalDescription: prose(4000).default(''),
      publicDescription: prose(4000).default(''),
      participantInstructions: prose(4000).default(''),
      language: z.string().min(2).max(16).default('en-US'),
      targetDurationMinutes: z.number().min(1).max(240).default(10),
      privacy: z.enum(PRIVACY).default('PRIVATE'),
      tags: z.array(shortText(40)).max(20).default([]),
    })
    .default({}),

  persona: z
    .object({
      /** The role the AI plays, e.g. "Hiring manager at a fintech startup". */
      role: prose(1000).default(''),
      name: shortText(80).default(''),
      /** Free-form persona prose (author's words, preserved). */
      description: prose(8000).default(''),
      voice: z
        .object({
          provider: z.string().max(32).default('browser'),
          voiceId: z.string().max(128).default(''),
          speed: z.number().min(0.5).max(2).default(1),
        })
        .default({}),
      avatar: z
        .object({
          kind: z.enum(['none', 'initials', 'image']).default('initials'),
          imageUrl: z.string().url().max(2000).optional(),
          accentColor: z.string().max(32).optional(),
        })
        .default({}),
    })
    .default({}),

  instructions: z
    .object({
      /** Author's AI instructions (prose, preserved verbatim). */
      aiInstructions: prose(20000).default(''),
      goals: z.array(shortText(500)).max(30).default([]),
      /** Things the agent must never do / topics it must refuse. */
      boundaries: z.array(shortText(500)).max(30).default([]),
      tone: shortText(200).default('professional and warm'),
      /** How much the agent talks: concise answers are best for voice. */
      verbosity: z.enum(['concise', 'balanced', 'detailed']).default('concise'),
    })
    .default({}),

  conversation: z
    .object({
      /**
       * adaptive: agenda is a guide; agent forms follow-ups from answers (default).
       * fixed_questions: agent asks agenda.fixedQuestion items verbatim, in order; minimal follow-ups.
       * hybrid: fixed questions where given, adaptive elsewhere.
       */
      strategy: z.enum(['adaptive', 'fixed_questions', 'hybrid']).default('adaptive'),
      agenda: z.array(AgendaItemSchema).max(40).default([]),
      firstTurn: z
        .object({
          speaker: z.enum(['agent', 'participant']).default('agent'),
          /** What the agent says first. Supports {{variables}} from the allowlist. */
          text: prose(2000).default(''),
        })
        .default({}),
      ending: z
        .object({
          closingMessage: prose(2000).default(''),
          /** Start the closing exchange once all required agenda topics are covered. */
          endWhenAgendaComplete: z.boolean().default(true),
          allowParticipantEnd: z.boolean().default(true),
          /** Hard cap; the session ends gracefully at this point. */
          maxDurationMinutes: z.number().min(1).max(240).default(30),
          /** Minutes before the cap at which the agent is asked to wrap up. */
          wrapUpLeadMinutes: z.number().min(0).max(30).default(2),
        })
        .default({}),
      turnTaking: z
        .object({
          /** vad: automatic end-of-turn detection; push_to_talk: participant holds a button. */
          mode: z.enum(['vad', 'push_to_talk']).default('vad'),
          /** Silence needed before we treat an utterance as finished (ms). */
          endOfTurnSilenceMs: z.number().int().min(300).max(5000).default(1200),
          /**
           * If the participant pauses mid-thought (incomplete sentence / filler), wait up to this long
           * before prompting. Pauses are NOT interrupted by default.
           */
          thinkingPauseGraceMs: z.number().int().min(0).max(60000).default(15000),
          /** After this much total silence, the agent may gently check in (0 = never). */
          silenceCheckInMs: z.number().int().min(0).max(120000).default(25000),
          allowBargeIn: z.boolean().default(true),
        })
        .default({}),
      timedInstructions: z.array(TimedInstructionSchema).max(20).default([]),
    })
    .default({}),

  model: z
    .object({
      voiceMode: z.enum(VOICE_MODES).default('pipeline'),
      llmProvider: z.enum(LLM_PROVIDERS).default('anthropic'),
      llmModel: z.string().max(100).default(''),
      temperature: z.number().min(0).max(1.5).default(0.7),
      sttProvider: z.enum(STT_PROVIDERS).default('browser'),
      ttsProvider: z.enum(TTS_PROVIDERS).default('browser'),
      realtimeProvider: z.enum(REALTIME_PROVIDERS).default('openai'),
      realtimeModel: z.string().max(100).default(''),
    })
    .default({}),

  audio: z
    .object({
      echoCancellation: z.boolean().default(true),
      noiseSuppression: z.boolean().default(true),
      autoGainControl: z.boolean().default(true),
      allowCamera: z.boolean().default(false),
    })
    .default({}),

  recording: z
    .object({
      audio: z.boolean().default(true),
      video: z.boolean().default(false),
      /** Consent is always required when recording or analysis is on; this controls the notice text. */
      consentNotice: prose(2000).default(''),
      retentionDays: z.number().int().min(1).max(3650).default(365),
    })
    .default({}),

  analysis: z
    .object({
      enabled: z.boolean().default(true),
      participantCanSeeTranscript: z.boolean().default(true),
      participantCanSeeFeedback: z.boolean().default(true),
      participantCanSeeScores: z.boolean().default(false),
      /** Hiring/assessment outcomes are advisory; a human must review. */
      requireHumanReview: z.boolean().default(false),
      notifyOnComplete: z.boolean().default(false),
    })
    .default({}),

  rubric: RubricSchema.default({}),

  extraction: z
    .object({
      variables: z.array(ExtractionVariableSchema).max(50).default([]),
    })
    .default({}),

  variables: z
    .object({
      /** Only these keys may be substituted into {{...}} placeholders at runtime. */
      allowlist: z.array(RuntimeVariableSchema).max(30).default([]),
    })
    .default({}),

  memory: z
    .object({
      enabled: z.boolean().default(false),
      maxFactsInPrompt: z.number().int().min(0).max(50).default(12),
      /** Allow the agent to save new facts about the learner after the session. */
      learnFromSessions: z.boolean().default(true),
    })
    .default({}),

  coach: z
    .object({
      enabled: z.boolean().default(false),
      /** Teaching → practice → feedback structure. */
      phases: z
        .array(z.enum(['teach', 'practice', 'feedback']))
        .max(3)
        .default(['teach', 'practice', 'feedback']),
      focusSkill: shortText(200).default(''),
    })
    .default({}),

  tools: z
    .object({
      enabled: z.array(ToolEnablementSchema).max(30).default([{ toolId: 'end_session', enabled: true, config: {}, usageHint: '' }]),
      /** Workspace CustomFunction ids granted to this scenario (server-side execution only). */
      customFunctionIds: z.array(z.string().max(64)).max(20).default([]),
    })
    .default({}),

  knowledge: z
    .object({
      documentIds: z.array(z.string().max(64)).max(100).default([]),
      topK: z.number().int().min(1).max(10).default(4),
      /** Let the agent search knowledge automatically on each participant turn. */
      autoRetrieve: z.boolean().default(true),
    })
    .default({}),

  channels: z
    .object({
      browser: z
        .object({
          enabled: z.boolean().default(true),
          allowTextFallback: z.boolean().default(true),
          showCaptions: z.boolean().default(true),
          showArtifactPanel: z.boolean().default(true),
        })
        .default({}),
      embed: z.object({ enabled: z.boolean().default(true) }).default({}),
      phone: z
        .object({
          enabled: z.boolean().default(false),
          greetingOverride: prose(1000).optional(),
          transferNumber: z.string().max(32).optional(),
        })
        .default({}),
      meeting: z.object({ enabled: z.boolean().default(false) }).default({}),
    })
    .default({}),

  access: z
    .object({
      identityMode: z.enum(IDENTITY_MODES).default('NAME_EMAIL'),
      defaultAttemptLimitPerEmail: z.number().int().min(1).max(1000).optional(),
    })
    .default({}),
});

export type ScenarioConfig = z.infer<typeof ScenarioConfigSchema>;
export type ScenarioConfigInput = z.input<typeof ScenarioConfigSchema>;

/** Parse permissively (drafts): returns a fully-defaulted config or zod issues. */
export function parseScenarioConfig(input: unknown) {
  return ScenarioConfigSchema.safeParse(input ?? {});
}

export function defaultScenarioConfig(overrides?: ScenarioConfigInput): ScenarioConfig {
  return ScenarioConfigSchema.parse(overrides ?? {});
}

export interface ValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

/** Numbers that are "equal" for weight sums (avoid float drift). */
export const WEIGHT_EPSILON = 0.01;

/**
 * Publish-time validation: structural (zod) + semantic rules.
 * Errors block publishing; warnings are shown but allowed.
 */
export function validateScenarioForPublish(input: unknown): {
  ok: boolean;
  config?: ScenarioConfig;
  issues: ValidationIssue[];
} {
  const issues: ValidationIssue[] = [];
  const parsed = ScenarioConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      issues.push({ path: i.path.join('.'), message: i.message, severity: 'error' });
    }
    return { ok: false, issues };
  }
  const c = parsed.data;
  const req = (cond: boolean, path: string, message: string) => {
    if (!cond) issues.push({ path, message, severity: 'error' });
  };
  const warn = (cond: boolean, path: string, message: string) => {
    if (!cond) issues.push({ path, message, severity: 'warning' });
  };

  req(c.basics.name.trim().length > 0, 'basics.name', 'Name is required');
  req(c.basics.publicDescription.trim().length > 0, 'basics.publicDescription', 'Public description is required');
  req(
    c.basics.participantInstructions.trim().length > 0,
    'basics.participantInstructions',
    'Participant instructions are required',
  );
  req(c.persona.role.trim().length > 0, 'persona.role', 'AI role/persona is required');
  req(c.instructions.goals.filter((g) => g.trim()).length > 0, 'instructions.goals', 'Add at least one goal');
  req(
    c.conversation.firstTurn.speaker === 'participant' || c.conversation.firstTurn.text.trim().length > 0,
    'conversation.firstTurn.text',
    'First turn text is required when the agent speaks first',
  );
  req(
    c.conversation.ending.closingMessage.trim().length > 0 || c.conversation.ending.endWhenAgendaComplete === false,
    'conversation.ending.closingMessage',
    'Add a closing message (or disable ending when the agenda is complete)',
  );
  warn(c.conversation.agenda.length > 0, 'conversation.agenda', 'No agenda: the agent will rely on goals only');
  warn(c.instructions.boundaries.length > 0, 'instructions.boundaries', 'No boundaries set');

  if (c.conversation.strategy === 'fixed_questions') {
    c.conversation.agenda.forEach((a, idx) =>
      req(
        !!a.fixedQuestion && a.fixedQuestion.trim().length > 0,
        `conversation.agenda.${idx}.fixedQuestion`,
        'Fixed-question strategy requires a question for every agenda item',
      ),
    );
  }

  const maxMin = c.conversation.ending.maxDurationMinutes;
  req(
    c.basics.targetDurationMinutes <= maxMin,
    'basics.targetDurationMinutes',
    'Target duration must not exceed the maximum duration',
  );
  c.conversation.timedInstructions.forEach((t, idx) =>
    req(t.atSecond <= maxMin * 60, `conversation.timedInstructions.${idx}.atSecond`, 'Timed instruction is after the maximum duration'),
  );

  uniq(c.conversation.agenda.map((a) => a.id), 'conversation.agenda', 'Agenda ids must be unique', issues);
  uniq(c.conversation.timedInstructions.map((a) => a.id), 'conversation.timedInstructions', 'Timed instruction ids must be unique', issues);

  if (c.rubric.enabled && c.analysis.enabled) {
    req(c.rubric.criteria.length > 0, 'rubric.criteria', 'Add at least one rubric criterion (or disable the rubric)');
    req(c.rubric.evaluatedSubject.trim().length > 0, 'rubric.evaluatedSubject', 'Say who or what is evaluated');
    const sum = c.rubric.criteria.reduce((s, k) => s + k.weight, 0);
    if (c.rubric.criteria.length > 0) {
      req(
        Math.abs(sum - 100) <= WEIGHT_EPSILON,
        'rubric.criteria',
        `Criterion weights must sum to 100 (currently ${round2(sum)})`,
      );
    }
    c.rubric.criteria.forEach((k, idx) => {
      req(k.name.trim().length > 0, `rubric.criteria.${idx}.name`, 'Criterion name is required');
      req(k.weight > 0, `rubric.criteria.${idx}.weight`, 'Weight must be greater than 0');
      warn(k.strongPerformance.trim().length > 0, `rubric.criteria.${idx}.strongPerformance`, 'Describe strong performance');
      warn(k.weakPerformance.trim().length > 0, `rubric.criteria.${idx}.weakPerformance`, 'Describe weak performance');
    });
    uniq(c.rubric.criteria.map((k) => k.id), 'rubric.criteria', 'Criterion ids must be unique', issues);
  }

  uniq(c.extraction.variables.map((v) => v.key), 'extraction.variables', 'Extraction keys must be unique', issues);
  uniq(c.variables.allowlist.map((v) => v.key), 'variables.allowlist', 'Variable keys must be unique', issues);
  c.variables.allowlist.forEach((v, idx) => {
    if (v.pattern) {
      try {
        new RegExp(`^(?:${v.pattern})$`, 'u');
        const risk = regexPatternRisk(v.pattern);
        if (risk) issues.push({ path: `variables.allowlist.${idx}.pattern`, message: risk, severity: 'error' });
      } catch {
        issues.push({ path: `variables.allowlist.${idx}.pattern`, message: 'Invalid pattern', severity: 'error' });
      }
    }
  });

  // Placeholders must reference allowlisted variables only.
  const allowed = new Set(c.variables.allowlist.map((v) => v.key));
  for (const [path, text] of templatedFields(c)) {
    for (const key of findPlaceholders(text)) {
      if (!allowed.has(key)) {
        issues.push({ path, message: `Unknown variable {{${key}}} — add it to the variable allowlist`, severity: 'error' });
      }
    }
  }

  if (c.channels.phone.enabled && c.model.ttsProvider === 'browser') {
    issues.push({
      path: 'model.ttsProvider',
      message: 'Phone calls cannot use browser speech; a server TTS provider will be used for the phone channel',
      severity: 'warning',
    });
  }

  const filtered = issues.filter((i) => i.message);
  return { ok: !filtered.some((i) => i.severity === 'error'), config: c, issues: filtered };
}

function uniq(values: string[], path: string, message: string, issues: ValidationIssue[]) {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) {
      issues.push({ path, message: `${message} (duplicate: ${v})`, severity: 'error' });
      return;
    }
    seen.add(v);
  }
}

function round2(n: number) {
  return Math.round(n * 100) / 100;
}

/** Fields in which {{variable}} placeholders are allowed. */
export function templatedFields(c: ScenarioConfig): Array<[string, string]> {
  const out: Array<[string, string]> = [
    ['basics.participantInstructions', c.basics.participantInstructions],
    ['instructions.aiInstructions', c.instructions.aiInstructions],
    ['persona.role', c.persona.role],
    ['persona.name', c.persona.name],
    ['persona.description', c.persona.description],
    ['conversation.firstTurn.text', c.conversation.firstTurn.text],
    ['conversation.ending.closingMessage', c.conversation.ending.closingMessage],
  ];
  c.conversation.agenda.forEach((a, i) => {
    out.push([`conversation.agenda.${i}.guidance`, a.guidance]);
    if (a.fixedQuestion) out.push([`conversation.agenda.${i}.fixedQuestion`, a.fixedQuestion]);
  });
  return out;
}

export const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function findPlaceholders(text: string): string[] {
  const keys: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER_RE)) keys.push(m[1]!);
  return keys;
}

/**
 * Normalize for publishing: trims outer whitespace on strings (prose inner content preserved),
 * drops disabled/empty entries, fills generated ids. Input must already be schema-valid.
 */
export function normalizeScenarioConfig(c: ScenarioConfig): ScenarioConfig {
  const clone: ScenarioConfig = JSON.parse(JSON.stringify(c));
  trimStrings(clone);
  clone.instructions.goals = clone.instructions.goals.filter((g) => g.length > 0);
  clone.instructions.boundaries = clone.instructions.boundaries.filter((g) => g.length > 0);
  clone.basics.tags = Array.from(new Set(clone.basics.tags.filter(Boolean).map((t) => t.toLowerCase())));
  clone.tools.enabled = clone.tools.enabled.filter((t) => t.enabled);
  return clone;
}

function trimStrings(obj: any) {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') obj[i] = obj[i].trim();
      else if (obj[i] && typeof obj[i] === 'object') trimStrings(obj[i]);
    }
    return;
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (typeof v === 'string') obj[k] = v.trim();
    else if (v && typeof v === 'object') trimStrings(v);
  }
}

/** Stable JSON stringify (sorted keys) for hashing configs. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .filter((k) => (value as any)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`)
    .join(',')}}`;
}

// ── Field paths (for the drafting assistant, locking, diffs) ──

export function getAtPath(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

export function setAtPath<T>(obj: T, path: string, value: unknown): T {
  const clone: any = JSON.parse(JSON.stringify(obj ?? {}));
  const parts = path.split('.');
  let cur = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]!;
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = /^\d+$/.test(parts[i + 1]!) ? [] : {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]!] = value;
  return clone;
}

/**
 * Top-level editable field paths shown in the editor and targeted by the drafting assistant.
 * Arrays are treated as a single field (e.g. the whole agenda), which keeps diffs reviewable.
 */
export const EDITABLE_FIELD_PATHS = [
  'basics.name',
  'basics.type',
  'basics.internalDescription',
  'basics.publicDescription',
  'basics.participantInstructions',
  'basics.language',
  'basics.targetDurationMinutes',
  'basics.privacy',
  'basics.tags',
  'persona.role',
  'persona.name',
  'persona.description',
  'persona.voice',
  'persona.avatar',
  'instructions.aiInstructions',
  'instructions.goals',
  'instructions.boundaries',
  'instructions.tone',
  'instructions.verbosity',
  'conversation.strategy',
  'conversation.agenda',
  'conversation.firstTurn',
  'conversation.ending',
  'conversation.turnTaking',
  'conversation.timedInstructions',
  'model',
  'audio',
  'recording',
  'analysis',
  'rubric',
  'extraction.variables',
  'variables.allowlist',
  'memory',
  'coach',
  'tools',
  'knowledge',
  'channels',
  'access',
] as const;
export type EditableFieldPath = (typeof EDITABLE_FIELD_PATHS)[number];

export interface FieldChange {
  path: string;
  before: unknown;
  after: unknown;
  reason?: string;
}

/** Diff two configs at the granularity of EDITABLE_FIELD_PATHS. */
export function diffConfigs(before: unknown, after: unknown): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const path of EDITABLE_FIELD_PATHS) {
    const a = getAtPath(before, path);
    const b = getAtPath(after, path);
    if (stableStringify(a ?? null) !== stableStringify(b ?? null)) changes.push({ path, before: a, after: b });
  }
  return changes;
}
