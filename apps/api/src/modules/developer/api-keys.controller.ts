import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { API_KEY_SCOPES } from '@cf/shared';
import type { z } from 'zod';
import { CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ApiKeysService, CreateApiKeySchema, ListApiKeysQuery, type CreateApiKeyInput } from './api-keys.service';

/** API key management (workspace admins, cookie session only — API keys cannot mint API keys). */
@ApiTags('api-keys')
@Controller('workspaces/:workspaceId/api-keys')
@RequireCapability('apikeys.manage')
export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  @Get('scopes')
  scopes() {
    return { data: API_KEY_SCOPES };
  }

  @Get()
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(ListApiKeysQuery)) q: z.infer<typeof ListApiKeysQuery>) {
    return this.keys.list(ws, q);
  }

  @Post()
  @ApiOperation({ summary: 'Create an API key. The secret is returned once.' })
  create(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateApiKeySchema)) body: CreateApiKeyInput) {
    return this.keys.create(ws, p, body);
  }

  @Post(':id/revoke')
  @HttpCode(200)
  revokePost(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.keys.revoke(ws, p, id);
  }

  @Delete(':id')
  revoke(@Param('workspaceId') ws: string, @Param('id') id: string, @CurrentPrincipal() p: Principal) {
    return this.keys.revoke(ws, p, id);
  }
}
