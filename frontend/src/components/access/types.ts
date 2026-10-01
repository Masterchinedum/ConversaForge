export type IdentityMode = 'NONE' | 'NAME' | 'EMAIL' | 'NAME_EMAIL';

export const IDENTITY_LABELS: Record<IdentityMode, string> = {
  NONE: 'Anonymous (no identity)',
  NAME: 'Name only',
  EMAIL: 'Email (name optional)',
  NAME_EMAIL: 'Name and email',
};

export interface AccessSummary {
  scenario: {
    id: string;
    name: string;
    privacy: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';
    status: string;
    galleryListed: boolean;
    latestVersionId: string | null;
    latestVersionNumber: number;
    archived: boolean;
  };
  runnable: boolean;
  versions: Array<{ id: string; version: number; publishedAt: string; changeNote: string | null }>;
  variables: Array<{ key: string; label: string; required: boolean; maxLength: number }>;
  identityModeDefault: IdentityMode;
  defaultAttemptLimitPerEmail: number | null;
  channels: { browser: boolean; embed: boolean };
  allowPublicScenarios: boolean;
  publicUrl: string;
  counts: { activeLinks: number; activeGrants: number; activeTokens: number };
}

export interface ShareLinkDto {
  id: string;
  label: string | null;
  url: string;
  mode: 'MULTI_USE' | 'ONE_TIME';
  maxUses: number | null;
  useCount: number;
  expiresAt: string | null;
  passcodeRequired: boolean;
  perEmailAttemptLimit: number | null;
  identityMode: IdentityMode;
  allowedEmailDomains: string[];
  prefilledVariables: Record<string, string>;
  pinnedVersionId: string | null;
  pinnedVersion: number | null;
  courseId: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'revoked' | 'expired' | 'exhausted';
  sessionCount?: number;
}

export interface GrantDto {
  id: string;
  granteeType: 'USER' | 'EMAIL' | 'WORKSPACE';
  granteeLabel: string | null;
  granteeEmail: string | null;
  permission: 'RUN' | 'VIEW_RESULTS' | 'EDIT';
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'revoked' | 'expired';
}

export interface AccessTokenDto {
  id: string;
  scenarioId: string | null;
  purpose: 'EMBED' | 'PARTICIPANT';
  prefix: string;
  participant: { externalId: string | null; email: string | null; name: string | null };
  allowedOrigins: string[];
  maxUses: number | null;
  useCount: number;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  status: 'active' | 'revoked' | 'expired' | 'exhausted';
}

export const STATUS_TONE = { active: 'green', revoked: 'red', expired: 'gray', exhausted: 'yellow' } as const;

/** <input type="datetime-local"> value ↔ ISO string. */
export function toLocalInput(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
export function fromLocalInput(v: string): string | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
