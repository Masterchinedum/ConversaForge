import { Global, Injectable, Logger, Module } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../../config/env';

/**
 * Email adapter. With SMTP_URL set, sends real mail; otherwise logs the message (dev) so flows like
 * invitations still work locally — the log line includes the link.
 */
@Injectable()
export class MailService {
  private readonly logger = new Logger('Mail');
  private readonly transporter: Transporter | null = env.SMTP_URL ? nodemailer.createTransport(env.SMTP_URL) : null;

  get configured() {
    return !!this.transporter;
  }

  async send(msg: { to: string; subject: string; text: string; html?: string }) {
    if (!this.transporter) {
      // Bodies carry bearer links (password reset, verification, invitations, personal run links): only
      // log them outside production, where logs are shipped and retained.
      if (env.NODE_ENV === 'production') this.logger.warn(`SMTP_URL is not configured; email to=${msg.to} subject="${msg.subject}" was NOT sent`);
      else this.logger.log(`[dev mail] to=${msg.to} subject="${msg.subject}"\n${msg.text}`);
      return { delivered: false, logged: true };
    }
    await this.transporter.sendMail({ from: env.MAIL_FROM, ...msg });
    return { delivered: true, logged: false };
  }
}

@Global()
@Module({ providers: [MailService], exports: [MailService] })
export class MailModule {}
