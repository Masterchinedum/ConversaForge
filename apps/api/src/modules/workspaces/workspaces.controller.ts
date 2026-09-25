import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { ApiScopes, CurrentPrincipal, CurrentUser, CurrentWorkspace, RequireCapability } from '../../common/auth/decorators';
import type { Principal, WorkspaceContext } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import { WorkspaceSettingsSchema, WorkspacesService } from './workspaces.service';

@ApiTags('workspaces')
@Controller('workspaces')
export class WorkspacesController {
  constructor(private readonly workspaces: WorkspacesService) {}

  @Post()
  create(@CurrentUser() user: Extract<Principal, { kind: 'user' }>, @Body(new ZodPipe(z.object({ name: z.string().min(1).max(80) }))) body: { name: string }) {
    return this.workspaces.createOrganization(user, body.name);
  }

  @Get(':workspaceId')
  @ApiScopes('org:read')
  async get(@Param('workspaceId') workspaceId: string, @CurrentWorkspace() ctx: WorkspaceContext) {
    const ws = await this.workspaces.get(workspaceId);
    return { ...ws, role: ctx.role };
  }

  @Patch(':workspaceId')
  @RequireCapability('workspace.manage')
  @ApiScopes('org:write')
  update(
    @Param('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(z.object({ name: z.string().min(1).max(80).optional(), settings: WorkspaceSettingsSchema.optional() })))
    body: { name?: string; settings?: z.infer<typeof WorkspaceSettingsSchema> },
  ) {
    return this.workspaces.update(workspaceId, principal, body);
  }
}
