// String-union mirrors of the Prisma enums so the web app never imports @prisma/client.

export const ROLES = ['OWNER', 'ADMIN', 'CREATOR', 'REVIEWER', 'MEMBER'] as const;
export type Role = (typeof ROLES)[number];

/** Higher rank = more privilege. Role checks use "at least" semantics except where noted. */
export const ROLE_RANK: Record<Role, number> = {
  MEMBER: 10,
  REVIEWER: 20,
  CREATOR: 30,
  ADMIN: 40,
  OWNER: 50,
};

export function roleAtLeast(role: Role | null | undefined, min: Role): boolean {
  if (!role) return false;
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Capability map used by both API guards and UI (hide buttons the user cannot use). */
export const CAPABILITIES = {
  'workspace.manage': 'ADMIN',
  'workspace.delete': 'OWNER',
  'members.manage': 'ADMIN',
  'branding.manage': 'ADMIN',
  'usage.view': 'ADMIN',
  'usage.manage': 'OWNER',
  'audit.view': 'ADMIN',
  'apikeys.manage': 'ADMIN',
  'webhooks.manage': 'ADMIN',
  'providers.manage': 'ADMIN',
  'scenarios.edit': 'CREATOR',
  'scenarios.publish': 'CREATOR',
  'scenarios.share': 'CREATOR',
  'knowledge.manage': 'CREATOR',
  'courses.edit': 'CREATOR',
  'courses.assign': 'CREATOR',
  'channels.manage': 'ADMIN',
  'sessions.review': 'REVIEWER',
  'analytics.view': 'REVIEWER',
  'exports.download': 'REVIEWER',
  'memory.manage': 'REVIEWER',
  'scenarios.run': 'MEMBER',
} as const satisfies Record<string, Role>;
export type Capability = keyof typeof CAPABILITIES;

export function can(role: Role | null | undefined, cap: Capability): boolean {
  return roleAtLeast(role, CAPABILITIES[cap]);
}

export const PRIVACY = ['PRIVATE', 'ORGANIZATION', 'PUBLIC'] as const;
export type Privacy = (typeof PRIVACY)[number];

export const SCENARIO_TYPES = [
  'interview',
  'coaching',
  'sales_practice',
  'negotiation',
  'leadership',
  'demo',
  'support',
  'custom',
] as const;
export type ScenarioType = (typeof SCENARIO_TYPES)[number];

export const SCENARIO_TYPE_LABELS: Record<ScenarioType, string> = {
  interview: 'Interview',
  coaching: 'Coaching',
  sales_practice: 'Sales practice',
  negotiation: 'Negotiation',
  leadership: 'Leadership conversation',
  demo: 'Product demo',
  support: 'Customer support',
  custom: 'Custom',
};

export const CHANNELS = ['BROWSER', 'EMBED', 'PHONE_INBOUND', 'PHONE_OUTBOUND', 'MEETING', 'API'] as const;
export type Channel = (typeof CHANNELS)[number];

export const PROCESSING_STATUSES = [
  'NOT_STARTED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'PARTIAL',
  'FAILED',
  'SKIPPED',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const IDENTITY_MODES = ['NONE', 'NAME', 'EMAIL', 'NAME_EMAIL'] as const;
export type IdentityMode = (typeof IDENTITY_MODES)[number];

export const USAGE_KINDS = [
  'SESSION_SECONDS',
  'LLM_INPUT_TOKENS',
  'LLM_OUTPUT_TOKENS',
  'STT_SECONDS',
  'TTS_CHARACTERS',
  'REALTIME_SECONDS',
  'ANALYSIS_INPUT_TOKENS',
  'ANALYSIS_OUTPUT_TOKENS',
  'STORAGE_BYTES',
  'TELEPHONY_SECONDS',
  'EMBEDDING_TOKENS',
] as const;
export type UsageKind = (typeof USAGE_KINDS)[number];

export const WEBHOOK_EVENTS = [
  'session.started',
  'session.completed',
  'session.analyzed',
  'session.extracted',
  'session.failed',
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENTS)[number];

export const API_KEY_SCOPES = [
  'scenarios:read',
  'scenarios:write',
  'sessions:read',
  'sessions:write',
  'analysis:read',
  'analytics:read',
  'courses:read',
  'courses:write',
  'org:read',
  'org:write',
  'tokens:write',
  'usage:read',
  'webhooks:write',
] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];
