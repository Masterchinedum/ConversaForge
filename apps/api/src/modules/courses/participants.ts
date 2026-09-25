import type { Participant, PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, 'participant' | 'enrollment'>;

export function normEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase();
  return e ? e.slice(0, 320) : null;
}

/**
 * The learner's Participant row in a workspace. Resolution matches the runtime's
 * SessionsService.upsertParticipant (oldest participant for (workspaceId, userId), else an unclaimed
 * participant with the same email, else a new one) so enrollments and sessions share one participant.
 */
export async function participantForUser(
  db: Db,
  workspaceId: string,
  user: { userId: string; email?: string | null; name?: string | null },
): Promise<Participant> {
  const byUser = await db.participant.findFirst({ where: { workspaceId, userId: user.userId }, orderBy: { createdAt: 'asc' } });
  if (byUser) return byUser;
  const email = normEmail(user.email);
  if (email) {
    const byEmail = await db.participant.findFirst({ where: { workspaceId, email, userId: null }, orderBy: { createdAt: 'asc' } });
    if (byEmail) {
      return db.participant.update({ where: { id: byEmail.id }, data: { userId: user.userId, name: byEmail.name ?? user.name ?? null, deletedAt: null } });
    }
  }
  return db.participant.create({ data: { workspaceId, userId: user.userId, email, name: user.name ?? null } });
}

/** Participant for an email-only assignment (someone who may not have an account yet). */
export async function participantForEmail(db: Db, workspaceId: string, emailRaw: string, userId: string | null): Promise<Participant> {
  const email = normEmail(emailRaw)!;
  if (userId) return participantForUser(db, workspaceId, { userId, email });
  const existing = await db.participant.findFirst({ where: { workspaceId, email }, orderBy: { createdAt: 'asc' } });
  if (existing) return existing;
  return db.participant.create({ data: { workspaceId, email } });
}

/**
 * Enrollments assigned to the user's email before they had an account (or before their participant row
 * was linked) are moved onto their participant. Only unclaimed (userId null) participants are touched.
 */
export async function claimEmailEnrollments(db: Db, workspaceId: string, user: { userId: string; email: string | null }, mine: Participant) {
  const email = normEmail(user.email);
  if (!email) return 0;
  const pending = await db.enrollment.findMany({
    where: { workspaceId, userId: null, participantId: { not: mine.id } },
    select: { id: true, courseId: true, participantId: true },
  });
  if (!pending.length) return 0;
  const orphanParticipants = await db.participant.findMany({
    where: { id: { in: pending.map((p) => p.participantId) }, workspaceId, email, userId: null },
    select: { id: true },
  });
  const orphanIds = new Set(orphanParticipants.map((p) => p.id));
  let moved = 0;
  for (const e of pending) {
    if (!orphanIds.has(e.participantId)) continue;
    const clash = await db.enrollment.findFirst({ where: { courseId: e.courseId, participantId: mine.id } });
    if (clash) continue;
    await db.enrollment.update({ where: { id: e.id }, data: { participantId: mine.id, userId: user.userId } });
    moved++;
  }
  // Also set userId on enrollments already attached to my participant (e.g. email participant just linked).
  await db.enrollment.updateMany({ where: { workspaceId, participantId: mine.id, userId: null }, data: { userId: user.userId } });
  return moved;
}
