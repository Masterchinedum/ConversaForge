import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { env } from '../../config/env';
import { AuditService } from '../../common/audit/audit.service';
import { CryptoService } from '../../common/crypto/crypto.service';
import { Errors } from '../../common/http/errors';
import { MailService } from '../../common/mail/mail.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { WorkspacesService } from '../workspaces/workspaces.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly workspaces: WorkspacesService,
    private readonly audit: AuditService,
    private readonly mail: MailService,
  ) {}

  async signup(input: { email: string; password: string; name: string }, meta: { ip?: string; userAgent?: string }) {
    const email = input.email.trim().toLowerCase();
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw Errors.conflict('An account with this email already exists');
    const passwordHash = await hash(input.password);
    const user = await this.prisma.user.create({ data: { email, name: input.name.trim(), passwordHash } });
    await this.workspaces.createPersonal(user.id, user.name ?? email);
    // Link any participant records created for this email before signup (e.g. via share links).
    await this.prisma.participant.updateMany({ where: { email, userId: null }, data: { userId: user.id } });
    await this.audit.log({ workspaceId: null, principal: null, action: 'user.signup', targetType: 'user', targetId: user.id, ip: meta.ip });
    return this.createSession(user.id, meta);
  }

  async login(input: { email: string; password: string }, meta: { ip?: string; userAgent?: string }) {
    const email = input.email.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    // Constant-ish time: always run a verify.
    const ok = user?.passwordHash
      ? await verify(user.passwordHash, input.password).catch(() => false)
      : (await verify('$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$ZmFrZWhhc2hmYWtlaGFzaGZha2VoYXNo', input.password).catch(() => false), false);
    if (!user || !ok || user.deletedAt) throw Errors.unauthorized('Invalid email or password');
    return this.createSession(user.id, meta);
  }

  async createSession(userId: string, meta: { ip?: string; userAgent?: string }) {
    const token = this.crypto.randomToken(32);
    const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 86400_000);
    await this.prisma.authSession.create({
      data: { userId, tokenHash: this.crypto.sha256(token), expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) },
    });
    return { token, expiresAt };
  }

  async logout(authSessionId: string) {
    await this.prisma.authSession.update({ where: { id: authSessionId }, data: { revokedAt: new Date() } }).catch(() => undefined);
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { id: true, email: true, name: true, avatarUrl: true, createdAt: true, isSuperAdmin: true },
    });
    const memberships = await this.prisma.membership.findMany({
      where: { userId, workspace: { deletedAt: null } },
      include: { workspace: { select: { id: true, name: true, slug: true, kind: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return {
      user,
      workspaces: memberships.map((m) => ({ ...m.workspace, role: m.role })),
    };
  }

  async updateProfile(userId: string, data: { name?: string }) {
    return this.prisma.user.update({ where: { id: userId }, data: { name: data.name }, select: { id: true, email: true, name: true } });
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string, keepSessionId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await verify(user.passwordHash, currentPassword).catch(() => false))) {
      throw Errors.unauthorized('Current password is incorrect');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hash(newPassword) } });
    await this.prisma.authSession.updateMany({ where: { userId, id: { not: keepSessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ workspaceId: null, principal: null, action: 'user.password_changed', targetType: 'user', targetId: userId });
  }

  async requestPasswordReset(emailRaw: string) {
    const email = emailRaw.trim().toLowerCase();
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) return; // do not reveal whether the account exists
    const token = this.crypto.randomToken(32);
    await this.prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: this.crypto.sha256(token), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const link = `${env.WEB_PUBLIC_URL}/reset-password?token=${token}`;
    await this.mail.send({ to: email, subject: 'Reset your ConversaForge password', text: `Reset your password: ${link}\nThis link expires in 1 hour.` });
  }

  async resetPassword(token: string, newPassword: string) {
    const rec = await this.prisma.passwordResetToken.findUnique({ where: { tokenHash: this.crypto.sha256(token) } });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) throw Errors.badRequest('This reset link is invalid or has expired');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: rec.userId }, data: { passwordHash: await hash(newPassword) } }),
      this.prisma.passwordResetToken.update({ where: { id: rec.id }, data: { usedAt: new Date() } }),
      this.prisma.authSession.updateMany({ where: { userId: rec.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }
}
