import { Body, Controller, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { roleAtLeast } from '@cf/shared';
import { z } from 'zod';
import { CurrentUser, CurrentWorkspace } from '../../common/auth/decorators';
import { verifiedEmail, type Principal, type WorkspaceContext } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { ZodPipe } from '../../common/http/zod.pipe';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { SessionsService } from './sessions.service';

const SelfRunBody = z
  .object({
    variables: z.record(z.union([z.string().max(4000), z.number(), z.boolean()])).optional(),
    coachMode: z.boolean().optional(),
    enrollmentId: z.string().max(64).optional(),
    courseItemAttemptId: z.string().max(64).optional(),
  })
  .strict();

/** Workspace members start a session for themselves ("Run" / "Practice" buttons, courses). */
@ApiTags('sessions')
@Controller('workspaces/:workspaceId/scenarios/:scenarioId/sessions')
export class SessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
    private readonly rateLimit: RateLimitService,
  ) {}

  @Post()
  async create(
    @Param('workspaceId') workspaceId: string,
    @Param('scenarioId') scenarioId: string,
    @Body(new ZodPipe(SelfRunBody)) body: z.infer<typeof SelfRunBody>,
    @CurrentUser() user: Extract<Principal, { kind: 'user' }>,
    @CurrentWorkspace() ws: WorkspaceContext,
  ) {
    await this.rateLimit.enforce(`selfrun:user:${user.userId}`, 30, 60, 'You are starting sessions too quickly');
    const scenario = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!scenario) throw Errors.notFound('Scenario');
    // PRIVATE scenarios: creators and above in this workspace. Grants/links are handled by the access module.
    if (scenario.privacy === 'PRIVATE' && !roleAtLeast(ws.role, 'CREATOR')) throw Errors.notFound('Scenario');

    if (body.enrollmentId) {
      const enrollment = await this.prisma.enrollment.findFirst({ where: { id: body.enrollmentId, workspaceId } });
      if (!enrollment) throw Errors.notFound('Enrollment');
      const participant = await this.prisma.participant.findFirst({ where: { id: enrollment.participantId, workspaceId } });
      if (enrollment.userId !== user.userId && participant?.userId !== user.userId) throw Errors.forbidden('Not your enrollment');
      if (body.courseItemAttemptId) {
        const attempt = await this.prisma.courseItemAttempt.findFirst({
          where: { id: body.courseItemAttemptId, enrollmentId: enrollment.id },
          include: { courseItem: { select: { scenarioId: true } } },
        });
        if (!attempt) throw Errors.notFound('Course item attempt');
        if (attempt.courseItem.scenarioId && attempt.courseItem.scenarioId !== scenarioId) {
          throw Errors.badRequest('The course item attempt belongs to a different scenario');
        }
      }
    } else if (body.courseItemAttemptId) {
      throw Errors.badRequest('courseItemAttemptId requires enrollmentId');
    }

    const { session, sessionToken } = await this.sessions.createSession({
      workspaceId,
      scenarioId,
      channel: 'BROWSER',
      // Unverified addresses must not attach the account to anonymous participant rows with that email.
      participant: { userId: user.userId, email: verifiedEmail(user), name: user.name },
      variables: body.variables,
      coachMode: body.coachMode,
      enrollmentId: body.enrollmentId,
      courseItemAttemptId: body.courseItemAttemptId,
      metadata: { startedBy: 'member', role: ws.role },
    });
    return { sessionId: session.id, sessionToken };
  }
}
