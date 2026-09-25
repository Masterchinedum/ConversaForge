import { Controller, Delete, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyRequest } from 'fastify';
import { CurrentUser, CurrentWorkspace, Public } from '../../common/auth/decorators';
import type { Principal, WorkspaceContext } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { CoursesService } from './courses.service';
import { LearnService, type LearnAccess, type LearnerRef } from './learn.service';

type UserPrincipal = Extract<Principal, { kind: 'user' }>;
const learner = (u: UserPrincipal): LearnerRef => ({ userId: u.userId, email: u.email, name: u.name });

/** Learner endpoints for workspace members (own data only). */
@ApiTags('learn')
@Controller('workspaces/:workspaceId/learn')
export class LearnController {
  constructor(private readonly learn: LearnService) {}

  private access(w: WorkspaceContext): LearnAccess {
    return { via: 'member', role: w.role };
  }

  @Get()
  overview(@Param('workspaceId') ws: string, @CurrentUser() u: UserPrincipal, @CurrentWorkspace() w: WorkspaceContext) {
    return this.learn.overview(ws, learner(u), w.role);
  }

  @Get('courses/:courseId')
  async detail(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentUser() u: UserPrincipal, @CurrentWorkspace() w: WorkspaceContext) {
    return this.learn.detail(await this.learn.loadMemberCourse(ws, id), learner(u), this.access(w));
  }

  @Post('courses/:courseId/enroll')
  @HttpCode(200)
  async enroll(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentUser() u: UserPrincipal, @CurrentWorkspace() w: WorkspaceContext) {
    const course = await this.learn.loadMemberCourse(ws, id);
    await this.learn.enroll(course, learner(u), this.access(w));
    return this.learn.detail(course, learner(u), this.access(w));
  }

  @Delete('courses/:courseId/enroll')
  async unenroll(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentUser() u: UserPrincipal) {
    return this.learn.unenroll(await this.learn.loadMemberCourse(ws, id), learner(u));
  }

  @Post('courses/:courseId/items/:itemId/start')
  @HttpCode(200)
  async start(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() u: UserPrincipal,
    @CurrentWorkspace() w: WorkspaceContext,
  ) {
    return this.learn.start(await this.learn.loadMemberCourse(ws, id), learner(u), itemId, this.access(w));
  }

  @Post('courses/:courseId/items/:itemId/complete')
  @HttpCode(200)
  async complete(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() u: UserPrincipal,
    @CurrentWorkspace() w: WorkspaceContext,
  ) {
    return this.learn.complete(await this.learn.loadMemberCourse(ws, id), learner(u), itemId, this.access(w));
  }

  @Get('courses/:courseId/items/:itemId/content')
  async content(
    @Param('workspaceId') ws: string,
    @Param('courseId') id: string,
    @Param('itemId') itemId: string,
    @CurrentUser() u: UserPrincipal,
    @CurrentWorkspace() w: WorkspaceContext,
  ) {
    return this.learn.content(await this.learn.loadMemberCourse(ws, id), learner(u), itemId, this.access(w));
  }

  @Post('courses/:courseId/continue')
  @HttpCode(200)
  async continue(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentUser() u: UserPrincipal, @CurrentWorkspace() w: WorkspaceContext) {
    return this.learn.continue(await this.learn.loadMemberCourse(ws, id), learner(u), this.access(w));
  }

  @Post('courses/:courseId/start-over')
  @HttpCode(200)
  async startOver(@Param('workspaceId') ws: string, @Param('courseId') id: string, @CurrentUser() u: UserPrincipal, @CurrentWorkspace() w: WorkspaceContext) {
    return this.learn.startOver(await this.learn.loadMemberCourse(ws, id), learner(u), this.access(w));
  }
}

/**
 * Course share links (/c/<token>): public course info for anyone (rate-limited); enrollment and the
 * player for any logged-in user holding the token. Revocation/rotation takes effect immediately
 * because every call re-resolves the token.
 */
@ApiTags('learn')
@Controller('c/:token')
export class PublicCourseController {
  constructor(
    private readonly learn: LearnService,
    private readonly courses: CoursesService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private readonly access: LearnAccess = { via: 'token' };

  private user(req: FastifyRequest): UserPrincipal {
    const p = req.principal;
    if (!p || p.kind !== 'user') throw Errors.unauthorized('Sign in to take this course');
    return p;
  }

  @Public()
  @Get()
  async info(@Param('token') token: string, @Req() req: FastifyRequest) {
    await this.rateLimit.enforce(`course-link:ip:${req.ip}`, 120, 60);
    const course = await this.learn.loadTokenCourse(token);
    const [ws, branding] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: course.workspaceId }, select: { name: true } }),
      this.prisma.workspaceBranding.findUnique({ where: { workspaceId: course.workspaceId }, select: { displayName: true, primaryColor: true, logoUrl: true } }),
    ]);
    const p = req.principal;
    let membership: { role: string } | null = null;
    let enrolled = false;
    if (p?.kind === 'user') {
      membership = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: course.workspaceId, userId: p.userId } }, select: { role: true } });
      const participant = await this.prisma.participant.findFirst({ where: { workspaceId: course.workspaceId, userId: p.userId }, orderBy: { createdAt: 'asc' } });
      if (participant) {
        const e = await this.prisma.enrollment.findUnique({ where: { courseId_participantId: { courseId: course.id, participantId: participant.id } } });
        enrolled = !!e && e.status !== 'DROPPED';
      }
    }
    return {
      course: {
        id: course.id,
        workspaceId: course.workspaceId,
        title: course.title,
        description: course.description,
        coverImageUrl: await this.courses.coverImageUrl(course),
        forcedOrder: course.forcedOrder,
        items: course.items.map((i) => ({ id: i.id, title: i.title, kind: i.kind, required: i.required })),
      },
      organization: { name: branding?.displayName || ws?.name || 'ConversaForge' , primaryColor: branding?.primaryColor ?? null, logoUrl: branding?.logoUrl ?? null },
      viewer: p?.kind === 'user' ? { signedIn: true, isMember: !!membership, enrolled } : { signedIn: false, isMember: false, enrolled: false },
    };
  }

  @Post('enroll')
  @HttpCode(200)
  async enroll(@Param('token') token: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    await this.rateLimit.enforce(`course-link:enroll:${u.userId}`, 30, 3600);
    const course = await this.learn.loadTokenCourse(token);
    await this.learn.enroll(course, learner(u), this.access);
    return this.learn.detail(course, learner(u), this.access);
  }

  @Get('player')
  async player(@Param('token') token: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    return this.learn.detail(await this.learn.loadTokenCourse(token), learner(u), this.access);
  }

  @Post('items/:itemId/start')
  @HttpCode(200)
  async start(@Param('token') token: string, @Param('itemId') itemId: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    await this.rateLimit.enforce(`course-link:start:${u.userId}`, 60, 3600);
    return this.learn.start(await this.learn.loadTokenCourse(token), learner(u), itemId, this.access);
  }

  @Post('items/:itemId/complete')
  @HttpCode(200)
  async complete(@Param('token') token: string, @Param('itemId') itemId: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    return this.learn.complete(await this.learn.loadTokenCourse(token), learner(u), itemId, this.access);
  }

  @Get('items/:itemId/content')
  async content(@Param('token') token: string, @Param('itemId') itemId: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    return this.learn.content(await this.learn.loadTokenCourse(token), learner(u), itemId, this.access);
  }

  @Post('continue')
  @HttpCode(200)
  async continue(@Param('token') token: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    await this.rateLimit.enforce(`course-link:start:${u.userId}`, 60, 3600);
    return this.learn.continue(await this.learn.loadTokenCourse(token), learner(u), this.access);
  }

  @Post('start-over')
  @HttpCode(200)
  async startOver(@Param('token') token: string, @Req() req: FastifyRequest) {
    const u = this.user(req);
    return this.learn.startOver(await this.learn.loadTokenCourse(token), learner(u), this.access);
  }
}
