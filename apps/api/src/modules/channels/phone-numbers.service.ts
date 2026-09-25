import { Injectable } from '@nestjs/common';
import { Prisma, type PhoneNumber } from '@prisma/client';
import { z } from 'zod';
import { AuditService } from '../../common/audit/audit.service';
import type { Principal } from '../../common/auth/principal';
import { Errors } from '../../common/http/errors';
import { PrismaService } from '../../common/prisma/prisma.service';
import { env } from '../../config/env';
import { normalizePhone } from './twilio/twiml';

export const CreatePhoneNumberBody = z
  .object({
    e164: z.string().trim().min(5).max(32),
    label: z.string().trim().max(120).optional().nullable(),
    inboundScenarioId: z.string().min(1).max(64).optional().nullable(),
  })
  .strict();
export const UpdatePhoneNumberBody = z
  .object({
    label: z.string().trim().max(120).optional().nullable(),
    inboundScenarioId: z.string().min(1).max(64).optional().nullable(),
  })
  .strict();

/** Twilio numbers owned by a workspace and the scenario that answers inbound calls. */
@Injectable()
export class PhoneNumbersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  webhookUrls() {
    const base = env.API_PUBLIC_URL.replace(/\/$/, '');
    return { voiceUrl: `${base}/api/channels/twilio/voice`, statusCallbackUrl: `${base}/api/channels/twilio/status` };
  }

  serialize(n: PhoneNumber) {
    return { id: n.id, provider: n.provider, e164: n.e164, label: n.label, inboundScenarioId: n.inboundScenarioId, createdAt: n.createdAt, updatedAt: n.updatedAt, ...this.webhookUrls() };
  }

  private async checkScenario(workspaceId: string, scenarioId: string | null | undefined) {
    if (!scenarioId) return;
    const s = await this.prisma.scenario.findFirst({ where: { id: scenarioId, workspaceId, deletedAt: null } });
    if (!s) throw Errors.notFound('Scenario');
  }

  async list(workspaceId: string) {
    const rows = await this.prisma.phoneNumber.findMany({ where: { workspaceId }, orderBy: { createdAt: 'asc' } });
    return { data: rows.map((r) => this.serialize(r)) };
  }

  async create(workspaceId: string, principal: Principal, input: z.infer<typeof CreatePhoneNumberBody>) {
    const e164 = normalizePhone(input.e164);
    if (!e164) throw Errors.validation('Use an E.164 number, e.g. +14155550123', [{ path: 'e164', message: 'Invalid phone number' }]);
    await this.checkScenario(workspaceId, input.inboundScenarioId);
    try {
      const n = await this.prisma.phoneNumber.create({
        data: { workspaceId, provider: 'twilio', e164, label: input.label ?? null, inboundScenarioId: input.inboundScenarioId ?? null },
      });
      await this.audit.log({ workspaceId, principal, action: 'channel.phone_number_added', targetType: 'phone_number', targetId: n.id, metadata: { e164 } });
      return this.serialize(n);
    } catch (e) {
      // Numbers are globally unique per provider: one workspace owns a number.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw Errors.conflict('This number is already connected to a workspace');
      throw e;
    }
  }

  async update(workspaceId: string, principal: Principal, id: string, input: z.infer<typeof UpdatePhoneNumberBody>) {
    const n = await this.prisma.phoneNumber.findFirst({ where: { id, workspaceId } });
    if (!n) throw Errors.notFound('Phone number');
    await this.checkScenario(workspaceId, input.inboundScenarioId);
    const u = await this.prisma.phoneNumber.update({
      where: { id: n.id },
      data: {
        ...(input.label !== undefined ? { label: input.label } : {}),
        ...(input.inboundScenarioId !== undefined ? { inboundScenarioId: input.inboundScenarioId } : {}),
      },
    });
    await this.audit.log({ workspaceId, principal, action: 'channel.phone_number_updated', targetType: 'phone_number', targetId: n.id, metadata: { inboundScenarioId: u.inboundScenarioId } });
    return this.serialize(u);
  }

  async remove(workspaceId: string, principal: Principal, id: string) {
    const n = await this.prisma.phoneNumber.findFirst({ where: { id, workspaceId } });
    if (!n) throw Errors.notFound('Phone number');
    await this.prisma.phoneNumber.delete({ where: { id: n.id } });
    await this.audit.log({ workspaceId, principal, action: 'channel.phone_number_removed', targetType: 'phone_number', targetId: n.id, metadata: { e164: n.e164 } });
    return { ok: true };
  }
}
