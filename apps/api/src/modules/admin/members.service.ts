import { Injectable } from '@nestjs/common';
import type { Invitation, Prisma, Role } from '@prisma/client';
import { ROLES } from '@cf/shared';
import { z } from 'zod';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal, WorkspaceContext } from '../../common/auth/principal';
import { CryptoService } from '../../common/crypto/crypto.service';
import { AppError, Errors } from '../../common/http/errors';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';

export const INVITATION_TTL_MS = 7 * 24 * 3600_000;
export const InviteBody = z.object({ email: z.string().trim().toLowerCase().email().max(254), role: z.enum(ROLES).default('MEMBER') }).strict();
export const ChangeRoleBody = z.object({ role: z.enum(ROLES) }).strict();

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

export function invitationStatus(i: Pick<Invitation, 'acceptedAt' | 'revokedAt' | 'expiresAt'>, now = new Date()) {
  if (i.acceptedAt) return 'accepted' as const;
  if (i.revokedAt) return 'revoked' as const;
  if (i.expiresAt <= now) return 'expired' as const;
  return 'pending' as const;
}

/**
 * Members, roles and invitations. Role rules:
 *  - only an OWNER may grant or revoke the OWNER role, and ADMINs cannot modify or remove OWNERs;
 *  - the last OWNER can never be demoted, removed or leave (checked under a row lock);
 *  - personal workspaces have exactly one member and cannot invite.
 */
@Injectable()
export class MembersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async list(workspaceId: string) {
    const rows = await this.prisma.membership.findMany({
      where: { workspaceId, user: { deletedAt: null } },
      include: { user: { select: { id: true, email: true, name: true } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return {
      data: rows.map((m) => ({ id: m.id, userId: m.userId, email: m.user.email, name: m.user.name, role: m.role, createdAt: m.createdAt })),
    };
  }

  private async membershipOr404(workspaceId: string, membershipId: string) {
    const m = await this.prisma.membership.findFirst({ where: { id: membershipId, workspaceId }, include: { user: { select: { email: true } } } });
    if (!m) throw Errors.notFound('Member');
    return m;
  }

  /**
   * Runs `fn` in a transaction after locking every OWNER membership row of the workspace, so two
   * concurrent demotions/removals cannot both see "another owner still exists".
   */
  private async withOwnerLock<T>(workspaceId: string, fn: (tx: Prisma.TransactionClient, ownerCount: number) => Promise<T>) {
    return this.prisma.$transaction(async (tx) => {
      const owners = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM "Membership" WHERE "workspaceId" = ${workspaceId} AND role = 'OWNER' FOR UPDATE`;
      return fn(tx, owners.length);
    });
  }

  async changeRole(workspaceId: string, membershipId: string, role: Role, actor: UserPrincipal | Principal, ctx: WorkspaceContext) {
    const target = await this.membershipOr404(workspaceId, membershipId);
    if (target.role === role) return { id: target.id, role };
    const actorIsOwner = ctx.role === 'OWNER';
    if ((target.role === 'OWNER' || role === 'OWNER') && !actorIsOwner) {
      throw Errors.forbidden('Only an owner can grant or change the owner role');
    }
    const updated = await this.withOwnerLock(workspaceId, async (tx, owners) => {
      const fresh = await tx.membership.findFirst({ where: { id: membershipId, workspaceId } });
      if (!fresh) throw Errors.notFound('Member');
      if (fresh.role === 'OWNER' && role !== 'OWNER' && owners <= 1) {
        throw new AppError(409, 'last_owner', 'A workspace needs at least one owner. Make someone else an owner first.');
      }
      return tx.membership.update({ where: { id: fresh.id }, data: { role } });
    });
    await this.audit.log({
      workspaceId,
      principal: actor,
      action: 'member.role_changed',
      targetType: 'membership',
      targetId: updated.id,
      metadata: { userId: updated.userId, email: target.user.email, from: target.role, to: role },
    });
    return { id: updated.id, role: updated.role };
  }

  async remove(workspaceId: string, membershipId: string, actor: Principal, ctx: WorkspaceContext) {
    const target = await this.membershipOr404(workspaceId, membershipId);
    if (target.role === 'OWNER' && ctx.role !== 'OWNER') throw Errors.forbidden('Only an owner can remove another owner');
    await this.withOwnerLock(workspaceId, async (tx, owners) => {
      const fresh = await tx.membership.findFirst({ where: { id: membershipId, workspaceId } });
      if (!fresh) throw Errors.notFound('Member');
      if (fresh.role === 'OWNER' && owners <= 1) throw new AppError(409, 'last_owner', 'You cannot remove the last owner of a workspace.');
      await tx.membership.delete({ where: { id: fresh.id } });
    });
    await this.audit.log({ workspaceId, principal: actor, action: 'member.removed', targetType: 'membership', targetId: membershipId, metadata: { userId: target.userId, email: target.user.email, role: target.role } });
    return { ok: true };
  }

  async leave(workspaceId: string, user: UserPrincipal) {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
    if (!ws) throw Errors.notFound('Workspace');
    if (ws.kind === 'PERSONAL') throw new AppError(409, 'personal_workspace', 'You cannot leave your personal workspace.');
    const m = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId, userId: user.userId } } });
    if (!m) throw Errors.notFound('Workspace');
    await this.withOwnerLock(workspaceId, async (tx, owners) => {
      if (m.role === 'OWNER' && owners <= 1) {
        throw new AppError(409, 'last_owner', 'You are the last owner. Make someone else an owner before leaving.');
      }
      await tx.membership.delete({ where: { id: m.id } });
    });
    await this.audit.log({ workspaceId, principal: user, action: 'member.left', targetType: 'membership', targetId: m.id, metadata: { userId: user.userId, role: m.role } });
    return { ok: true };
  }

  // ───────────────────────── invitations ─────────────────────────

  private inviteDto(i: Invitation & { invitedBy?: { name: string | null; email: string } | null }) {
    return {
      id: i.id,
      email: i.email,
      role: i.role,
      expiresAt: i.expiresAt,
      acceptedAt: i.acceptedAt,
      revokedAt: i.revokedAt,
      createdAt: i.createdAt,
      invitedBy: i.invitedBy ? i.invitedBy.name ?? i.invitedBy.email : null,
      status: invitationStatus(i),
    };
  }

  async listInvitations(workspaceId: string, includeAll = false) {
    const rows = await this.prisma.invitation.findMany({
      where: { workspaceId, ...(includeAll ? {} : { acceptedAt: null, revokedAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    const inviterIds = [...new Set(rows.map((r) => r.invitedById).filter((x): x is string => !!x))];
    const inviters = inviterIds.length ? await this.prisma.user.findMany({ where: { id: { in: inviterIds } }, select: { id: true, name: true, email: true } }) : [];
    return { data: rows.map((r) => this.inviteDto({ ...r, invitedBy: inviters.find((u) => u.id === r.invitedById) ?? null })) };
  }

  private async sendInviteEmail(workspaceId: string, email: string, role: Role, token: string, inviterName: string | null) {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, include: { branding: true } });
    const name = ws?.branding?.displayName || ws?.name || 'a workspace';
    const link = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/invite/${token}`;
    const footer = ws?.branding?.emailFooter ? `\n\n—\n${ws.branding.emailFooter}` : '';
    return this.mail.send({
      to: email,
      subject: `You're invited to join ${name} on ConversaForge`,
      text: `${inviterName ?? 'Someone'} invited you to join ${name} as ${role.toLowerCase()}.\n\nAccept the invitation: ${link}\n\nThis link expires in 7 days. If you were not expecting this, you can ignore this email.${footer}`,
    });
  }

  async invite(workspaceId: string, body: z.infer<typeof InviteBody>, actor: UserPrincipal | Principal, ctx: WorkspaceContext) {
    const ws = await this.prisma.workspace.findFirst({ where: { id: workspaceId, deletedAt: null } });
    if (!ws) throw Errors.notFound('Workspace');
    if (ws.kind === 'PERSONAL') {
      throw new AppError(409, 'personal_workspace', 'Personal workspaces cannot have other members. Create an organization to invite people.');
    }
    if (body.role === 'OWNER' && ctx.role !== 'OWNER') throw Errors.forbidden('Only an owner can invite another owner');
    const existing = await this.prisma.membership.findFirst({ where: { workspaceId, user: { email: body.email } } });
    if (existing) throw Errors.conflict('That person is already a member of this workspace');
    // Replace any outstanding invitation for the same email (the old link stops working).
    await this.prisma.invitation.updateMany({ where: { workspaceId, email: body.email, acceptedAt: null, revokedAt: null }, data: { revokedAt: new Date() } });
    const token = this.crypto.randomToken(32);
    const inv = await this.prisma.invitation.create({
      data: {
        workspaceId,
        email: body.email,
        role: body.role,
        tokenHash: this.crypto.sha256(token),
        expiresAt: new Date(Date.now() + INVITATION_TTL_MS),
        invitedById: actor.kind === 'user' ? actor.userId : null,
      },
    });
    const mail = await this.sendInviteEmail(workspaceId, body.email, body.role, token, actor.kind === 'user' ? actor.name ?? actor.email : null);
    await this.audit.log({ workspaceId, principal: actor, action: 'invitation.created', targetType: 'invitation', targetId: inv.id, metadata: { email: inv.email, role: inv.role } });
    return { ...this.inviteDto(inv), emailDelivered: mail.delivered };
  }

  async resend(workspaceId: string, id: string, actor: UserPrincipal | Principal, ctx: WorkspaceContext) {
    const inv = await this.prisma.invitation.findFirst({ where: { id, workspaceId } });
    if (!inv) throw Errors.notFound('Invitation');
    if (inv.acceptedAt) throw Errors.conflict('This invitation was already accepted');
    if (inv.revokedAt) throw Errors.conflict('This invitation was revoked; send a new one');
    if (inv.role === 'OWNER' && ctx.role !== 'OWNER') throw Errors.forbidden('Only an owner can manage owner invitations');
    // A fresh token each time: the previous email's link stops working.
    const token = this.crypto.randomToken(32);
    const row = await this.prisma.invitation.update({
      where: { id: inv.id },
      data: { tokenHash: this.crypto.sha256(token), expiresAt: new Date(Date.now() + INVITATION_TTL_MS) },
    });
    const mail = await this.sendInviteEmail(workspaceId, inv.email, inv.role, token, actor.kind === 'user' ? actor.name ?? actor.email : null);
    await this.audit.log({ workspaceId, principal: actor, action: 'invitation.resent', targetType: 'invitation', targetId: inv.id, metadata: { email: inv.email } });
    return { ...this.inviteDto(row), emailDelivered: mail.delivered };
  }

  async revokeInvitation(workspaceId: string, id: string, actor: Principal, ctx: WorkspaceContext) {
    const inv = await this.prisma.invitation.findFirst({ where: { id, workspaceId } });
    if (!inv) throw Errors.notFound('Invitation');
    if (inv.role === 'OWNER' && ctx.role !== 'OWNER') throw Errors.forbidden('Only an owner can manage owner invitations');
    if (inv.acceptedAt) throw Errors.conflict('This invitation was already accepted');
    if (inv.revokedAt) return this.inviteDto(inv);
    const row = await this.prisma.invitation.update({ where: { id: inv.id }, data: { revokedAt: new Date() } });
    await this.audit.log({ workspaceId, principal: actor, action: 'invitation.revoked', targetType: 'invitation', targetId: inv.id, metadata: { email: inv.email } });
    return this.inviteDto(row);
  }

  private async findByToken(token: string) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{20,128}$/.test(token)) throw Errors.notFound('Invitation');
    const inv = await this.prisma.invitation.findUnique({ where: { tokenHash: this.crypto.sha256(token) }, include: { workspace: { include: { branding: true } } } });
    if (!inv || inv.workspace.deletedAt) throw Errors.notFound('Invitation');
    return inv;
  }

  /** Public preview for /invite/<token>. */
  async preview(token: string) {
    const inv = await this.findByToken(token);
    const inviter = inv.invitedById ? await this.prisma.user.findUnique({ where: { id: inv.invitedById }, select: { name: true, email: true } }) : null;
    return {
      workspace: { id: inv.workspaceId, name: inv.workspace.branding?.displayName || inv.workspace.name, logoUrl: inv.workspace.branding?.logoUrl ?? null },
      inviter: inviter ? inviter.name ?? inviter.email : null,
      role: inv.role,
      email: inv.email,
      expiresAt: inv.expiresAt,
      status: invitationStatus(inv),
    };
  }

  async accept(token: string, user: UserPrincipal) {
    const inv = await this.findByToken(token);
    const status = invitationStatus(inv);
    if (status === 'revoked') throw Errors.gone('This invitation has been revoked.');
    if (status === 'expired') throw Errors.gone('This invitation has expired. Ask for a new one.');
    if (status === 'accepted') {
      const m = await this.prisma.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: user.userId } } });
      if (m) return { workspaceId: inv.workspaceId, role: m.role, alreadyMember: true };
      throw Errors.gone('This invitation was already used.');
    }
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new AppError(403, 'invitation_email_mismatch', `This invitation was sent to ${inv.email}. Sign in with that email address to accept it.`);
    }
    const result = await this.prisma.$transaction(async (tx) => {
      // Conditional update: only one concurrent accept can win.
      const claimed = await tx.invitation.updateMany({
        where: { id: inv.id, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
        data: { acceptedAt: new Date(), acceptedById: user.userId },
      });
      if (claimed.count === 0) throw Errors.gone('This invitation is no longer valid.');
      const existing = await tx.membership.findUnique({ where: { workspaceId_userId: { workspaceId: inv.workspaceId, userId: user.userId } } });
      if (existing) return { membership: existing, alreadyMember: true };
      const membership = await tx.membership.create({ data: { workspaceId: inv.workspaceId, userId: user.userId, role: inv.role, invitedById: inv.invitedById } });
      // The invitation token was emailed to this address, which proves control of the mailbox.
      const verified = await tx.user.updateMany({ where: { id: user.userId, email: user.email, emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } });
      // Link participant records created for this email (e.g. share-link runs) to the account — in every
      // workspace when the address has just been verified, as the verification link would.
      await tx.participant.updateMany({
        where: { ...(verified.count ? {} : { workspaceId: inv.workspaceId }), email: user.email.toLowerCase(), userId: null },
        data: { userId: user.userId },
      });
      return { membership, alreadyMember: false };
    });
    await this.audit.log({
      workspaceId: inv.workspaceId,
      principal: user,
      action: 'invitation.accepted',
      targetType: 'invitation',
      targetId: inv.id,
      metadata: { email: inv.email, role: result.membership.role, membershipId: result.membership.id },
    });
    return { workspaceId: inv.workspaceId, role: result.membership.role, alreadyMember: result.alreadyMember };
  }
}
