import type { Role } from '@cf/shared';

export type Principal =
  | { kind: 'user'; userId: string; email: string; name: string | null; authSessionId: string; isSuperAdmin: boolean }
  | { kind: 'apiKey'; apiKeyId: string; workspaceId: string; scopes: string[] };

export interface WorkspaceContext {
  workspaceId: string;
  /** Effective role. API keys act as ADMIN, limited further by their scopes. */
  role: Role;
  membershipId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal | null;
    workspace?: WorkspaceContext;
  }
}

export function actorFields(p: Principal | null | undefined): { actorUserId: string | null; actorApiKeyId: string | null } {
  if (!p) return { actorUserId: null, actorApiKeyId: null };
  return p.kind === 'user' ? { actorUserId: p.userId, actorApiKeyId: null } : { actorUserId: null, actorApiKeyId: p.apiKeyId };
}

export function userIdOf(p: Principal | null | undefined): string | null {
  return p?.kind === 'user' ? p.userId : null;
}
