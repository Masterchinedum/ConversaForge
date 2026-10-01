import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { ApiKeyScope, Capability } from '@cf/shared';
import type { FastifyRequest } from 'fastify';
import type { Principal, WorkspaceContext } from './principal';
import { Errors } from '../http/errors';

export const IS_PUBLIC = 'cf:isPublic';
export const CAPABILITY = 'cf:capability';
export const API_SCOPES = 'cf:apiScopes';

/** Route does not require authentication (a principal is still resolved if present). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/**
 * For routes with a `:workspaceId` param: minimum capability required (defaults to 'scenarios.run',
 * i.e. any member). The WorkspaceGuard enforces membership for every such route regardless.
 */
export const RequireCapability = (cap: Capability) => SetMetadata(CAPABILITY, cap);

/** Allow API-key access to this route with the given scope(s). Routes without it reject API keys. */
export const ApiScopes = (...scopes: ApiKeyScope[]) => SetMetadata(API_SCOPES, scopes);

export const CurrentPrincipal = createParamDecorator((_d: unknown, ctx: ExecutionContext): Principal | null => {
  return ctx.switchToHttp().getRequest<FastifyRequest>().principal ?? null;
});

/** The authenticated user (throws 401 if the principal is not a user). */
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext) => {
  const p = ctx.switchToHttp().getRequest<FastifyRequest>().principal;
  if (!p || p.kind !== 'user') throw Errors.unauthorized();
  return p;
});

export const CurrentWorkspace = createParamDecorator((_d: unknown, ctx: ExecutionContext): WorkspaceContext => {
  const w = ctx.switchToHttp().getRequest<FastifyRequest>().workspace;
  if (!w) throw Errors.forbidden('Workspace context missing');
  return w;
});
