/** Types and helpers for courses / learning pages (workstream F). */
import { storeSessionToken } from '@/lib/live/token';

export type ItemKind = 'SCENARIO' | 'VIDEO' | 'DOCUMENT' | 'LINK';
export type CompletionRule =
  | { type: 'session_completed' }
  | { type: 'min_score'; minScore: number }
  | { type: 'viewed' }
  | { type: 'manual' };
export type ItemStatus = 'NOT_STARTED' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';

export interface Progress {
  percent: number;
  completedRequired: number;
  totalRequired: number;
  complete: boolean;
}

export interface CourseSummary {
  id: string;
  workspaceId: string;
  title: string;
  description: string | null;
  coverImageUrl: string | null;
  forcedOrder: boolean;
  visibility: 'PRIVATE' | 'ORGANIZATION' | 'PUBLIC';
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
}

export interface EnrollmentInfo {
  id: string;
  status: 'ACTIVE' | 'COMPLETED' | 'DROPPED';
  generation: number;
  assigned: boolean;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  lastItemId: string | null;
}

export interface PlayerItem {
  id: string;
  position: number;
  kind: ItemKind;
  title: string;
  description: string | null;
  required: boolean;
  completionRule: CompletionRule;
  scenario: { id: string; name: string; type: string; publicDescription: string | null; runnable: boolean } | null;
  url: string | null;
  asset: { fileName: string | null; mimeType: string } | null;
  status: ItemStatus;
  locked: boolean;
  attemptCount: number;
  lastAttempt: {
    id: string;
    status: 'STARTED' | 'COMPLETED' | 'FAILED';
    reason: string | null;
    sessionId: string | null;
    score: number | null;
    startedAt: string;
    completedAt: string | null;
  } | null;
}

export interface PlayerDetail {
  course: CourseSummary;
  enrollment: EnrollmentInfo | null;
  progress: Progress;
  nextItemId: string | null;
  items: PlayerItem[];
  history: Array<{ generation: number; completedItems: number; attempts: number }>;
  canEnroll: boolean;
  canUnenroll: boolean;
  preview: boolean;
}

export interface ItemContent {
  url: string;
  mimeType: string | null;
  fileName: string | null;
  external: boolean;
}

export type StartResult =
  | { kind: 'SCENARIO'; itemId: string; attemptId: string; sessionId: string; sessionToken: string; liveUrl: string }
  | { kind: 'VIDEO' | 'DOCUMENT' | 'LINK'; itemId: string; content: ItemContent | null };

export const KIND_LABEL: Record<ItemKind, string> = {
  SCENARIO: 'Practice',
  VIDEO: 'Video',
  DOCUMENT: 'Document',
  LINK: 'Link',
};

export function ruleLabel(rule: CompletionRule): string {
  switch (rule.type) {
    case 'session_completed':
      return 'Complete the session';
    case 'min_score':
      return `Score at least ${rule.minScore}`;
    case 'viewed':
      return 'Mark as viewed';
    case 'manual':
      return 'Reviewer sign-off';
  }
}

/**
 * Signed media URLs served by the API's local driver are made same-origin (through the web proxy) so
 * PDFs can be shown in an iframe; S3 presigned URLs are left untouched.
 */
export function sameOriginMediaUrl(url: string): string {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.origin : 'http://localhost');
    if (u.pathname.startsWith('/api/media/signed/')) return u.pathname + u.search;
  } catch {
    /* ignore */
  }
  return url;
}

/** Persist the participant token (see ARCHITECTURE.md) and build the /live URL with a safe return path. */
export function liveHref(sessionId: string, sessionToken: string, returnPath: string): string {
  storeSessionToken(sessionId, sessionToken);
  return `/live/${sessionId}?return=${encodeURIComponent(returnPath)}`;
}

export function hasStoredToken(sessionId: string): boolean {
  try {
    return !!(sessionStorage.getItem(`cf:session:${sessionId}`) || localStorage.getItem(`cf:session:${sessionId}`));
  } catch {
    return false;
  }
}
