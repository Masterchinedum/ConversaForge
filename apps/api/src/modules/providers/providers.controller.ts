import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import {
  CustomFunctionInput,
  CustomFunctionPatch,
  CustomFunctionsService,
} from './custom-functions.service';
import {
  CreateConnectionSchema,
  ProvidersService,
  RotateSecretSchema,
  UpdateConnectionSchema,
  type CreateConnectionInput,
  type RotateSecretInput,
  type UpdateConnectionInput,
} from './providers.service';

/** Provider connections (BYO keys). ADMIN+ (`providers.manage`). Secrets are write-only. */
@ApiTags('providers')
@Controller('workspaces/:workspaceId/providers')
@RequireCapability('providers.manage')
export class ProvidersController {
  constructor(private readonly providers: ProvidersService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string, @Query('includeRevoked') includeRevoked?: string) {
    return this.providers.list(workspaceId, includeRevoked === 'true');
  }

  @Get('catalog')
  catalog() {
    return this.providers.catalog();
  }

  @Get('status')
  status(@Param('workspaceId') workspaceId: string) {
    return this.providers.status(workspaceId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CreateConnectionSchema)) body: CreateConnectionInput,
  ) {
    return this.providers.create(workspaceId, principal, body);
  }

  @Get(':connectionId')
  get(@Param('workspaceId') workspaceId: string, @Param('connectionId') id: string) {
    return this.providers.get(workspaceId, id);
  }

  @Patch(':connectionId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') id: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(UpdateConnectionSchema)) body: UpdateConnectionInput,
  ) {
    return this.providers.update(workspaceId, principal, id, body);
  }

  @Post(':connectionId/rotate')
  @HttpCode(200)
  rotate(
    @Param('workspaceId') workspaceId: string,
    @Param('connectionId') id: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(RotateSecretSchema)) body: RotateSecretInput,
  ) {
    return this.providers.rotate(workspaceId, principal, id, body);
  }

  @Post(':connectionId/verify')
  @HttpCode(200)
  verify(@Param('workspaceId') workspaceId: string, @Param('connectionId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.providers.verify(workspaceId, principal, id);
  }

  @Post(':connectionId/revoke')
  @HttpCode(200)
  revoke(@Param('workspaceId') workspaceId: string, @Param('connectionId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.providers.revoke(workspaceId, principal, id);
  }

  /** Same as revoke (rows are kept for the audit trail; the secret is wiped). */
  @Delete(':connectionId')
  remove(@Param('workspaceId') workspaceId: string, @Param('connectionId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.providers.revoke(workspaceId, principal, id);
  }
}

const TestSchema = z.object({ args: z.record(z.unknown()).default({}) });

/** Custom functions (HTTPS tools). ADMIN+ (`providers.manage`). */
@ApiTags('functions')
@Controller('workspaces/:workspaceId/functions')
@RequireCapability('providers.manage')
export class CustomFunctionsController {
  constructor(private readonly functions: CustomFunctionsService) {}

  @Get()
  list(@Param('workspaceId') workspaceId: string) {
    return this.functions.list(workspaceId);
  }

  @Post()
  create(
    @Param('workspaceId') workspaceId: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CustomFunctionInput)) body: CustomFunctionInput,
  ) {
    return this.functions.create(workspaceId, principal, body);
  }

  @Get(':functionId')
  get(@Param('workspaceId') workspaceId: string, @Param('functionId') id: string) {
    return this.functions.get(workspaceId, id);
  }

  @Patch(':functionId')
  update(
    @Param('workspaceId') workspaceId: string,
    @Param('functionId') id: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(CustomFunctionPatch)) body: CustomFunctionPatch,
  ) {
    return this.functions.update(workspaceId, principal, id, body);
  }

  @Delete(':functionId')
  remove(@Param('workspaceId') workspaceId: string, @Param('functionId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.functions.remove(workspaceId, principal, id);
  }

  /** Dry run against the real URL with the given arguments (signed like a real call; context.test = true). */
  @Post(':functionId/test')
  @HttpCode(200)
  test(
    @Param('workspaceId') workspaceId: string,
    @Param('functionId') id: string,
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodPipe(TestSchema)) body: z.infer<typeof TestSchema>,
  ) {
    return this.functions.test(workspaceId, principal, id, body.args);
  }

  @Post(':functionId/signing-secret')
  @HttpCode(200)
  signingSecret(@Param('workspaceId') workspaceId: string, @Param('functionId') id: string, @CurrentPrincipal() principal: Principal) {
    return this.functions.revealSigningSecret(workspaceId, principal, id);
  }
}
