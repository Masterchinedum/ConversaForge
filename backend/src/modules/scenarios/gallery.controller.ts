import { Controller, Get, Param, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { can } from '@cf/shared';
import { CurrentWorkspace, Public } from '../../common/auth/decorators';
import type { WorkspaceContext } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { GalleryService } from './gallery.service';
import { GalleryQuery } from './scenarios.schemas';

const Id = z.string().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/);

/** Public gallery (no login, rate-limited per IP). Returns public-safe fields only. */
@ApiTags('gallery')
@Controller('gallery')
export class PublicGalleryController {
  constructor(
    private readonly gallery: GalleryService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private async limit(req: FastifyRequest) {
    await this.rateLimit.enforce(`gallery:ip:${req.ip}`, 300, 300);
  }

  @Public()
  @Get()
  async list(@Req() req: FastifyRequest, @Query(new ZodPipe(GalleryQuery)) q: GalleryQuery) {
    await this.limit(req);
    return this.gallery.publicList(q);
  }

  @Public()
  @Get('templates')
  async templates(@Req() req: FastifyRequest, @Query(new ZodPipe(GalleryQuery)) q: GalleryQuery) {
    await this.limit(req);
    return { data: this.gallery.templates(q) };
  }

  @Public()
  @Get('templates/:key')
  async template(@Req() req: FastifyRequest, @Param('key', new ZodPipe(Id)) key: string) {
    await this.limit(req);
    return this.gallery.templateDetail(key);
  }

  @Public()
  @Get(':scenarioId')
  async detail(@Req() req: FastifyRequest, @Param('scenarioId', new ZodPipe(Id)) id: string) {
    await this.limit(req);
    return this.gallery.publicDetail(id);
  }
}

/** Workspace gallery: templates + org-visible published scenarios. Any member. */
@ApiTags('gallery')
@Controller('workspaces/:workspaceId/gallery')
export class WorkspaceGalleryController {
  constructor(private readonly gallery: GalleryService) {}

  @Get()
  list(
    @Param('workspaceId') ws: string,
    @CurrentWorkspace() ctx: WorkspaceContext,
    @Query(new ZodPipe(GalleryQuery)) q: GalleryQuery,
  ) {
    return this.gallery.workspaceGallery(ws, can(ctx.role, 'scenarios.edit'), q);
  }
}
