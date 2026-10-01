import { Body, Controller, Get, HttpCode, Patch, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { CurrentUser, Public } from '../../common/auth/decorators';
import { SESSION_COOKIE } from '../../common/auth/auth.guard';
import type { Principal } from '../../common/auth/principal';
import { ZodPipe } from '../../common/http/zod.pipe';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AuthService } from './auth.service';

const Password = z.string().min(10, 'Use at least 10 characters').max(200);
const SignupBody = z.object({ email: z.string().email().max(254), password: Password, name: z.string().min(1).max(100) });
const LoginBody = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(200) });

type UserPrincipal = Extract<Principal, { kind: 'user' }>;

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly rateLimit: RateLimitService,
  ) {}

  private setCookie(reply: FastifyReply, token: string, expiresAt: Date) {
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      // Always Secure in production (HTTPS); COOKIE_SECURE opts in elsewhere (e.g. an HTTPS staging host).
      secure: env.COOKIE_SECURE || env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/',
      expires: expiresAt,
    });
  }

  @Public()
  @Post('signup')
  async signup(@Body(new ZodPipe(SignupBody)) body: z.infer<typeof SignupBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.rateLimit.enforce(`signup:${req.ip}`, 10, 3600);
    const s = await this.auth.signup(body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookie(reply, s.token, s.expiresAt);
    // The token lives only in the httpOnly cookie (never in the body, so scripts can't read it).
    return { ok: true };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.rateLimit.enforce(`login:ip:${req.ip}`, 30, 900, 'Too many login attempts. Try again later.');
    await this.rateLimit.enforce(`login:email:${body.email.toLowerCase()}`, 10, 900, 'Too many login attempts. Try again later.');
    const s = await this.auth.login(body, { ip: req.ip, userAgent: req.headers['user-agent'] });
    this.setCookie(reply, s.token, s.expiresAt);
    // The token lives only in the httpOnly cookie (never in the body, so scripts can't read it).
    return { ok: true };
  }

  @Post('logout')
  @HttpCode(200)
  async logout(@CurrentUser() user: UserPrincipal, @Res({ passthrough: true }) reply: FastifyReply) {
    await this.auth.logout(user.authSessionId);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: UserPrincipal) {
    return this.auth.me(user.userId);
  }

  @Patch('me')
  updateMe(@CurrentUser() user: UserPrincipal, @Body(new ZodPipe(z.object({ name: z.string().min(1).max(100).optional() }))) body: { name?: string }) {
    return this.auth.updateProfile(user.userId, body);
  }

  @Post('change-password')
  @HttpCode(200)
  async changePassword(
    @CurrentUser() user: UserPrincipal,
    @Body(new ZodPipe(z.object({ currentPassword: z.string().min(1), newPassword: Password }))) body: { currentPassword: string; newPassword: string },
  ) {
    await this.auth.changePassword(user.userId, body.currentPassword, body.newPassword, user.authSessionId);
    return { ok: true };
  }

  @Public()
  @Post('verify-email')
  @HttpCode(200)
  async verifyEmail(@Body(new ZodPipe(z.object({ token: z.string().min(10).max(2000) }))) body: { token: string }, @Req() req: FastifyRequest) {
    await this.rateLimit.enforce(`verify-email:ip:${req.ip}`, 30, 3600);
    return this.auth.verifyEmail(body.token);
  }

  @Post('resend-verification')
  @HttpCode(200)
  async resendVerification(@CurrentUser() user: UserPrincipal) {
    await this.rateLimit.enforce(`verify-email:resend:${user.userId}`, 5, 3600, 'Too many verification emails requested. Try again later.');
    return this.auth.sendVerification(user.userId);
  }

  @Public()
  @Post('forgot-password')
  @HttpCode(200)
  async forgot(@Body(new ZodPipe(z.object({ email: z.string().email() }))) body: { email: string }, @Req() req: FastifyRequest) {
    await this.rateLimit.enforce(`forgot:${req.ip}`, 5, 3600);
    // Per-address cap too, so rotating IPs cannot mail-bomb one inbox with reset links.
    await this.rateLimit.enforce(`forgot:email:${body.email.trim().toLowerCase()}`, 3, 3600);
    await this.auth.requestPasswordReset(body.email);
    return { ok: true };
  }

  @Public()
  @Post('reset-password')
  @HttpCode(200)
  async reset(@Body(new ZodPipe(z.object({ token: z.string().min(10), password: Password }))) body: { token: string; password: string }) {
    await this.auth.resetPassword(body.token, body.password);
    return { ok: true };
  }
}
