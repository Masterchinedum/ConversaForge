import type { FieldChange, ScenarioConfig, ValidationIssue } from '@cf/shared';

export interface ScenarioRow {
  id: string;
  slug: string;
  name: string;
  type: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  privacy: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';
  tags: string[];
  publicDescription: string | null;
  isTemplate: boolean;
  galleryListed: boolean;
  latestVersionId: string | null;
  latestVersionNumber: number;
  latestPublishedAt?: string | null;
  draftHasUnpublishedChanges?: boolean;
  sessionCount?: number;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface ScenarioDetail {
  scenario: ScenarioRow;
  draft: { config: ScenarioConfig; lockedFields: string[]; revision: number; baseVersionId: string | null; updatedAt: string };
  latestVersion: {
    id: string;
    version: number;
    publishedAt: string;
    changeNote: string | null;
    configHash: string;
    publishedBy: { id: string; name: string | null; email: string } | null;
  } | null;
  draftHasUnpublishedChanges: boolean;
  issues: ValidationIssue[];
  canPublish: boolean;
  sessionCount: number;
}

export interface VersionRow {
  id: string;
  version: number;
  configHash: string;
  changeNote: string | null;
  publishedAt: string;
  publishedBy: { id: string; name: string | null; email: string | null } | null;
  rolledBackFromVersionId: string | null;
  rolledBackFromVersion: number | null;
  isLatest: boolean;
  matchesDraft: boolean;
  sessionCount: number;
}

export interface DiffResponse {
  from: { ref: string; label: string; versionId: string | null };
  to: { ref: string; label: string; versionId: string | null };
  changes: FieldChange[];
}

export interface Proposal {
  id: string;
  instruction: string;
  changes: Array<{ path: string; before: unknown; after: unknown; reason: string }>;
  dropped: Array<{ path: string; reason: string }>;
  status: 'PENDING' | 'APPLIED' | 'PARTIAL' | 'REJECTED' | 'STALE';
  appliedPaths: string[];
  provider: string | null;
  model: string | null;
  simulated: boolean;
  createdAt: string;
  notes?: string[];
}

export interface GalleryCardData {
  kind: 'template' | 'scenario';
  id: string;
  name: string;
  type: string;
  typeLabel: string;
  publicDescription: string;
  durationMinutes: number;
  personaName: string | null;
  tags: string[];
  summary?: string;
  templateKey?: string;
  workspace?: { name: string; logoUrl: string | null; primaryColor: string | null } | null;
  runUrl?: string | null;
  privacy?: string;
  isTemplate?: boolean;
  published?: boolean;
  latestVersionNumber?: number;
}
