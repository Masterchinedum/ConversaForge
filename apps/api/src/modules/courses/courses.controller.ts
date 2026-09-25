import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CurrentPrincipal, RequireCapability } from '../../common/auth/decorators';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
import { ASSET_LIMITS, type AssetPurpose } from './course-media';
import {
  CoursesService,
  CreateCourseBody,
  ItemBody,
  ListCoursesQuery,
  ReorderBody,
  UpdateCourseBody,
  UpdateItemBody,
} from './courses.service';
import { AssignBody, EnrollmentsService } from './enrollments.service';

const PurposeQuery = z.object({ purpose: z.enum(['cover', 'video', 'document']) });

/** Read a single multipart file into memory with a size cap. */
export async function readUpload(req: FastifyRequest, maxBytes: number): Promise<{ buffer: Buffer; fileName: string | null }> {
  const r = req as FastifyRequest & { isMultipart?: () => boolean; file?: (o?: unknown) => Promise<any> };
  if (!r.isMultipart?.() || !r.file) throw Errors.validation('Send the file as multipart/form-data (field "file")');
  const part = await r.file({ limits: { fileSize: maxBytes, files: 1 } });
  if (!part) throw Errors.validation('No file received');
  try {
    const buffer: Buffer = await part.toBuffer();
    if (part.file?.truncated) throw Errors.validation(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    return { buffer, fileName: part.filename ?? null };
  } catch (e: any) {
    if (e?.code === 'FST_REQ_FILE_TOO_LARGE' || e?.statusCode === 413) {
      throw Errors.validation(`File too large (max ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    }
    throw e;
  }
}

@ApiTags('courses')
@Controller('workspaces/:workspaceId/courses')
export class CoursesController {
  constructor(
    private readonly courses: CoursesService,
    private readonly enrollments: EnrollmentsService,
  ) {}

  @Get()
  @RequireCapability('sessions.review')
  list(@Param('workspaceId') ws: string, @Query(new ZodPipe(ListCoursesQuery)) q: z.infer<typeof ListCoursesQuery>) {
    return this.courses.list(ws, q).then((data) => ({ data }));
  }

  @Post()
  @RequireCapability('courses.edit')
  create(@Param('workspaceId') ws: string, @CurrentPrincipal() p: Principal, @Body(new ZodPipe(CreateCourseBody)) body: z.infer<typeof CreateCourseBody>) {
    return this.courses.create(ws, p, body);
  }

  @Get('options/scenarios')
  @RequireCapability('courses.edit')
  scenarioOptions(@Param('workspaceId') ws: string) {
    return this.courses.scenarioOptions(ws).then((data) => ({ data }));
  }

  @Get('options/assignees')
  @RequireCapability('courses.assign')
  assignees(@Param('workspaceId') ws: string) {
    return this.enrollments.assignable(ws);
  }

  @Get(':courseId')
  @RequireCapability('sessions.review')
  get(@Param('workspaceId') ws: string, @Param('courseId') id: string) {
    return this.courses.get(ws, id);
  }

  @Patch(':courseId')
  @RequireCapability('courses.edit')
  update(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(UpdateCourseBody)) body: z.infer<typeof UpdateCourseBody>,
  ) {
    return this.courses.update(ws, id, p, body);
  }

  @Delete(':courseId')
  @RequireCapability('courses.edit')
  remove(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentPrincipal() p: Principal) {
    return this.courses.remove(ws, id, p);
  }

  // share link
  @Post(':courseId/share-token')
  @RequireCapability('courses.assign')
  rotateShare(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentPrincipal() p: Principal) {
    return this.courses.rotateShareToken(ws, id, p);
  }

  @Delete(':courseId/share-token')
  @RequireCapability('courses.assign')
  revokeShare(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentPrincipal() p: Principal) {
    return this.courses.revokeShareToken(ws, id, p);
  }

  // assets (cover image, video, pdf)
  @Post(':courseId/assets')
  @RequireCapability('courses.edit')
  async upload(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @CurrentPrincipal() p: Principal,
    @Query(new ZodPipe(PurposeQuery)) q: { purpose: AssetPurpose },
    @Req() req: FastifyRequest,
  ) {
    await this.courses.findCourse(ws, id);
    const file = await readUpload(req, ASSET_LIMITS[q.purpose]);
    return this.courses.uploadAsset(ws, id, p, file, q.purpose);
  }

  @Delete(':courseId/cover')
  @RequireCapability('courses.edit')
  removeCover(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentPrincipal() p: Principal) {
    return this.courses.removeCover(ws, id, p);
  }

  // items
  @Post(':courseId/items')
  @RequireCapability('courses.edit')
  addItem(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(ItemBody)) body: z.infer<typeof ItemBody>,
  ) {
    return this.courses.addItem(ws, id, p, body);
  }

  @Put(':courseId/items/order')
  @RequireCapability('courses.edit')
  reorder(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(ReorderBody)) body: z.infer<typeof ReorderBody>,
  ) {
    return this.courses.reorder(ws, id, p, body.itemIds);
  }

  @Patch(':courseId/items/:itemId')
  @RequireCapability('courses.edit')
  updateItem(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @Param('itemId') itemId: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(UpdateItemBody)) body: z.infer<typeof UpdateItemBody>,
  ) {
    return this.courses.updateItem(ws, id, itemId, p, body);
  }

  @Delete(':courseId/items/:itemId')
  @RequireCapability('courses.edit')
  removeItem(@Param('workspaceId') ws: string, @Param('courseId') id: string, @Param('itemId') itemId: string, @CurrentPrincipal() p: Principal) {
    return this.courses.removeItem(ws, id, itemId, p);
  }

  // enrollments
  @Get(':courseId/enrollments')
  @RequireCapability('sessions.review')
  enrollmentsList(@Param('workspaceId') ws: string, @Param('courseId') id: string, @Query('includeDropped') includeDropped?: string) {
    return this.enrollments.list(ws, id, { includeDropped: includeDropped === 'true' }).then((data) => ({ data }));
  }

  @Post(':courseId/enrollments')
  @RequireCapability('courses.assign')
  assign(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @CurrentPrincipal() p: Principal,
    @Body(new ZodPipe(AssignBody)) body: z.infer<typeof AssignBody>,
  ) {
    return this.enrollments.assign(ws, id, p, body);
  }

  @Get(':courseId/enrollments/:enrollmentId')
  @RequireCapability('sessions.review')
  enrollmentDetail(@Param('workspaceId') ws: string, @Param('courseId') id: string, @Param('enrollmentId') eid: string) {
    return this.enrollments.detail(ws, id, eid);
  }

  @Delete(':courseId/enrollments/:enrollmentId')
  @RequireCapability('courses.assign')
  unenroll(@Param('workspaceId') ws: string, @Param('courseId') id: string, @Param('enrollmentId') eid: string, @CurrentPrincipal() p: Principal) {
    return this.enrollments.unenroll(ws, id, eid, p);
  }

  @Post(':courseId/enrollments/:enrollmentId/items/:itemId/complete')
  @HttpCode(200)
  @RequireCapability('sessions.review')
  markComplete(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @Param('enrollmentId') eid: string,
    @Param('itemId') itemId: string,
    @CurrentPrincipal() p: Principal,
  ) {
    return this.enrollments.markComplete(ws, id, eid, itemId, p);
  }
}
