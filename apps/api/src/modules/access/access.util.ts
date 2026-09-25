import type { Scenario, ScenarioVersion } from '@prisma/client';
import { ScenarioConfigSchema, resolveVariables, substituteVariables, type IdentityMode, type ScenarioConfig } from '@cf/shared';
// Installs the time-bounded tester for runtime variable patterns (ReDoS guard).
import '../../common/security/regex-guard';
import { z } from 'zod';
import { AppError, Errors } from '../../common/http/errors';
import type { PrismaService } from '../../common/prisma/prisma.service';

/** Share-link tokens: 32 random bytes, base64url (43 chars). Accept a slightly wider range defensively. */
export const LINK_TOKEN_RE = /^[A-Za-z0-9_-]{20,128}$/;
export const EMBED_TOKEN_PREFIX = 'cfe_';
export const PARTICIPANT_TOKEN_PREFIX = 'cfp_';
export const MAX_TOKEN_TTL_SECONDS = 30 * 24 * 3600;
export const DEFAULT_TOKEN_TTL_SECONDS = 3600;

/** A 410 with a machine-readable reason the landing pages turn into a friendly message. */
export function gone(code: 'link_revoked' | 'link_expired' | 'link_exhausted' | 'scenario_unavailable' | 'token_revoked' | 'token_expired' | 'token_exhausted', message: string) {
  return new AppError(410, code, message, { reason: code });
}

export interface RunnableScenario {
  scenario: Scenario;
  version: ScenarioVersion;
  config: ScenarioConfig;
}

/**
 * Loads a scenario and the version a new session would run (pinned or latest published), scoped to
 * the workspace. Throws 410 `scenario_unavailable` when it can no longer be run.
 */
export async function loadRunnableScenario(
  prisma: PrismaService,
  workspaceId: string,
  scenarioId: string,
  versionId?: string | null,
): Promise<RunnableScenario> {
  const scenario = await prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
  if (!scenario || scenario.archivedAt || scenario.status === 'ARCHIVED') {
    throw gone('scenario_unavailable', 'This conversation is no longer available.');
  }
  const vid = versionId || scenario.latestVersionId;
  if (!vid) throw gone('scenario_unavailable', 'This conversation has not been published yet.');
  const version = await prisma.scenarioVersion.findFirst({ where: { id: vid, scenarioId, workspaceId } });
  if (!version) throw gone('scenario_unavailable', 'This conversation is no longer available.');
  const parsed = ScenarioConfigSchema.safeParse(version.config ?? {});
  if (!parsed.success) throw gone('scenario_unavailable', 'This conversation is misconfigured. Please contact the organizer.');
  return { scenario, version, config: parsed.data };
}

/** Participant-safe description of a scenario (never includes AI instructions, rubric or internal notes). */
/**
 * Participant-facing scenario info for landing pages. `{{placeholders}}` are filled with the values known
 * before the session starts (variable defaults + values fixed by the link/token); the rest show the
 * variable's label so participants never see template syntax.
 */
export function publicScenarioInfo(r: RunnableScenario, fixedVariables: Record<string, unknown> = {}) {
  const { scenario, version, config } = r;
  const known = resolveVariables(config.variables.allowlist, fixedVariables).values;
  const values: Record<string, string> = Object.fromEntries(config.variables.allowlist.map((v) => [v.key, `[${v.label || v.key}]`]));
  Object.assign(values, known);
  const fill = (text: string) => substituteVariables(text, values);
  return {
    id: scenario.id,
    name: config.basics.name || scenario.name,
    type: config.basics.type,
    description: fill(config.basics.publicDescription || scenario.publicDescription || ''),
    participantInstructions: fill(config.basics.participantInstructions),
    language: config.basics.language,
    durationMinutes: config.basics.targetDurationMinutes,
    maxDurationMinutes: config.conversation.ending.maxDurationMinutes,
    personaName: config.persona.name,
    recording: { audio: config.recording.audio, video: config.recording.video },
    version: version.version,
  };
}

export interface ParticipantVariableField {
  key: string;
  label: string;
  description: string;
  required: boolean;
  maxLength: number;
}

/** Variables a participant may still supply (allowlisted and not fixed by the link/token). */
export function participantVariableFields(config: ScenarioConfig, fixed: Record<string, unknown>): ParticipantVariableField[] {
  return config.variables.allowlist
    .filter((v) => !(v.key in fixed) && v.key !== 'participant_name')
    .map((v) => ({ key: v.key, label: v.label || v.key, description: v.description, required: v.required && !v.defaultValue, maxLength: v.maxLength }));
}

/** Keep only allowlisted keys (unknown keys are dropped silently — they come from untrusted callers). */
export function pickAllowlisted(config: ScenarioConfig, values: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!values || typeof values !== 'object') return out;
  const allowed = new Set(config.variables.allowlist.map((v) => v.key));
  for (const [k, v] of Object.entries(values)) {
    if (!allowed.has(k) || v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
  }
  return out;
}

/** Creator-supplied variables (link prefills, token variables) must use allowlisted keys: reject unknown keys. */
export function assertAllowlistedKeys(config: ScenarioConfig, values: Record<string, unknown>, path = 'prefilledVariables') {
  const allowed = new Set(config.variables.allowlist.map((v) => v.key));
  const unknown = Object.keys(values).filter((k) => !allowed.has(k));
  if (unknown.length) {
    throw Errors.validation(
      `Unknown variable${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}. Only variables on the scenario's allowlist can be set.`,
      unknown.map((k) => ({ path: `${path}.${k}`, message: 'Not on the scenario variable allowlist' })),
    );
  }
}

/**
 * Validate the final variable set before consuming a link use, so a participant who forgot a required
 * value does not burn a one-time link. (The runtime resolves them again when creating the session.)
 */
export function precheckVariables(config: ScenarioConfig, values: Record<string, string>, participantName?: string | null) {
  const implicit: Record<string, unknown> = {};
  if (participantName && config.variables.allowlist.some((v) => v.key === 'participant_name')) implicit.participant_name = participantName;
  const r = resolveVariables(config.variables.allowlist, implicit, values);
  if (r.errors.length) {
    throw Errors.validation(
      `Missing or invalid information: ${r.errors.map((e) => e.message).join('; ')}`,
      r.errors.map((e) => ({ path: `variables.${e.key}`, message: e.message })),
    );
  }
}

export const EmailSchema = z.string().trim().toLowerCase().email().max(254);
export const DomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Enter a domain like example.com or *.example.com');

export function emailDomainAllowed(email: string, allowed: string[]): boolean {
  if (!allowed.length) return true;
  const domain = email.split('@').pop()?.toLowerCase() ?? '';
  return allowed.some((d) => {
    const a = d.toLowerCase();
    if (a.startsWith('*.')) return domain.endsWith(a.slice(1)) || domain === a.slice(2);
    return domain === a;
  });
}

export function identityNeedsEmail(mode: IdentityMode) {
  return mode === 'EMAIL' || mode === 'NAME_EMAIL';
}
export function identityNeedsName(mode: IdentityMode) {
  return mode === 'NAME' || mode === 'NAME_EMAIL';
}

export const IdentityInput = z.object({
  name: z.string().trim().max(120).optional().nullable(),
  email: z.string().trim().max(254).optional().nullable(),
});

/**
 * Validate participant identity for the link/scenario identity mode. Returns normalized values.
 * `requireEmail` forces an email even when the mode would not ask for one (domain rules / attempt limits).
 */
export function validateIdentity(
  mode: IdentityMode,
  input: { name?: string | null; email?: string | null },
  opts: { allowedEmailDomains?: string[]; requireEmail?: boolean } = {},
): { name: string | null; email: string | null } {
  const name = input.name?.trim() ? input.name.trim().slice(0, 120) : null;
  let email: string | null = null;
  const wantsEmail = identityNeedsEmail(mode) || !!opts.requireEmail || !!opts.allowedEmailDomains?.length;
  if (input.email?.trim()) {
    const r = EmailSchema.safeParse(input.email);
    if (!r.success) throw Errors.validation('Please enter a valid email address', [{ path: 'email', message: 'Invalid email address' }]);
    email = r.data;
  }
  if (identityNeedsName(mode) && !name) throw Errors.validation('Please enter your name', [{ path: 'name', message: 'Name is required' }]);
  if (wantsEmail && !email) throw Errors.validation('Please enter your email address', [{ path: 'email', message: 'Email is required' }]);
  if (email && opts.allowedEmailDomains?.length && !emailDomainAllowed(email, opts.allowedEmailDomains)) {
    throw new AppError(403, 'email_domain_not_allowed', `This conversation is restricted to email addresses at: ${opts.allowedEmailDomains.join(', ')}`, {
      allowedEmailDomains: opts.allowedEmailDomains,
    });
  }
  // Identity the mode does not ask for is not stored (NONE stays anonymous unless an email rule applies).
  return { name: mode === 'NONE' ? null : name, email: wantsEmail ? email : null };
}

/** Normalize an origin (scheme://host[:port]); rejects paths, wildcards and non-http(s) schemes. */
export function normalizeOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

export const VariablesInput = z.record(z.union([z.string().max(4000), z.number(), z.boolean()])).optional();

/** Mask an email for display to someone who may not own it (e.g. invitation previews). */
export function maskEmail(email: string) {
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  return `${local.slice(0, 2)}${'•'.repeat(Math.max(1, Math.min(6, local.length - 2)))}@${domain}`;
}
