'use client';
import { createContext, useContext } from 'react';
import useSWR from 'swr';
import { can, type Capability, type Role } from '@cf/shared';

export interface MeResponse {
  user: { id: string; email: string; name: string | null; isSuperAdmin: boolean };
  workspaces: Array<{ id: string; name: string; slug: string; kind: 'PERSONAL' | 'ORGANIZATION'; role: Role }>;
}

export function useMe() {
  return useSWR<MeResponse>('/auth/me', { shouldRetryOnError: false });
}

export interface WorkspaceCtx {
  workspaceId: string;
  workspace: MeResponse['workspaces'][number];
  role: Role;
  me: MeResponse;
  can: (cap: Capability) => boolean;
  /** Build an API path scoped to the current workspace: wsPath('/scenarios') → /workspaces/<id>/scenarios */
  wsPath: (p: string) => string;
  /** Build a web route inside the workspace: href('/scenarios') → /w/<id>/scenarios */
  href: (p: string) => string;
}

export const WorkspaceContext = createContext<WorkspaceCtx | null>(null);

export function useWorkspace(): WorkspaceCtx {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside /w/[workspaceId]');
  return ctx;
}

export function makeWorkspaceCtx(me: MeResponse, workspaceId: string): WorkspaceCtx | null {
  const workspace = me.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  return {
    workspaceId,
    workspace,
    role: workspace.role,
    me,
    can: (cap) => can(workspace.role, cap),
    wsPath: (p) => `/workspaces/${workspaceId}${p.startsWith('/') ? p : `/${p}`}`,
    href: (p) => `/w/${workspaceId}${p === '/' ? '' : p.startsWith('/') ? p : `/${p}`}`,
  };
}
