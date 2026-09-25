import { Injectable, Logger } from '@nestjs/common';
import { env } from '../../config/env';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Payment-provider abstraction. Product logic (quotas, usage, alerts) never depends on a specific
 * provider; an adapter only mirrors customers/plans and receives metered usage.
 */
export interface BillingProvider {
  readonly id: string;
  /** Whether the adapter has the credentials it needs. */
  readonly configured: boolean;
  /** Human-readable explanation shown in the settings UI when not configured. */
  readonly statusMessage: string;
  createCustomer(workspace: { id: string; name: string; billingEmail: string | null }): Promise<{ externalCustomerId: string | null }>;
  reportUsage(workspaceId: string, externalCustomerId: string | null, usage: { metric: string; quantity: number; periodKey: string; idempotencyKey: string }): Promise<void>;
  getPlan(externalCustomerId: string | null): Promise<{ plan: string; status: string } | null>;
  portalUrl(externalCustomerId: string | null, returnUrl: string): Promise<string | null>;
}

/** Default: no payment provider. Every workspace is on the "free" plan; limits come from quotas. */
export class NoneBillingProvider implements BillingProvider {
  readonly id = 'none';
  readonly configured = true;
  readonly statusMessage = 'Billing is not enabled on this installation. Usage limits are managed with workspace quotas.';
  async createCustomer() {
    return { externalCustomerId: null };
  }
  async reportUsage() {
    /* nothing to report */
  }
  async getPlan() {
    return { plan: 'free', status: 'active' };
  }
  async portalUrl() {
    return null;
  }
}

/**
 * Stripe adapter STUB — intentionally not implemented and reported as "not configured".
 * To implement: add the `stripe` SDK (MIT), set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, then
 *  - createCustomer → stripe.customers.create({ name, email, metadata: { workspaceId } })
 *  - reportUsage    → Billing Meter events (stripe.billing.meterEvents.create) with the idempotency key
 *  - getPlan        → the customer's active subscription price lookup_key
 *  - portalUrl      → stripe.billingPortal.sessions.create({ customer, return_url })
 *  - a webhook route (customer.subscription.*) that updates BillingAccount.plan/status.
 * See docs/workstreams/E-access-admin.md.
 */
export class StripeBillingProvider implements BillingProvider {
  readonly id = 'stripe';
  readonly configured = false;
  readonly statusMessage: string;
  constructor(hasKey: boolean) {
    this.statusMessage = hasKey
      ? 'Stripe billing is selected, but the Stripe adapter is a stub in this build (no SDK integration yet). Usage limits are managed with quotas.'
      : 'Stripe billing is selected but not configured: set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET, and install the Stripe adapter.';
  }
  private notConfigured(): never {
    throw new Error('Stripe billing adapter is not configured');
  }
  async createCustomer(): Promise<{ externalCustomerId: string | null }> {
    return this.notConfigured();
  }
  async reportUsage(): Promise<void> {
    return this.notConfigured();
  }
  async getPlan() {
    return null;
  }
  async portalUrl() {
    return null;
  }
}

@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');
  readonly provider: BillingProvider =
    env.BILLING_PROVIDER === 'stripe' ? new StripeBillingProvider(!!env.STRIPE_SECRET_KEY) : new NoneBillingProvider();

  constructor(private readonly prisma: PrismaService) {}

  async get(workspaceId: string) {
    let account = await this.prisma.billingAccount.findUnique({ where: { workspaceId } });
    if (!account) {
      account = await this.prisma.billingAccount
        .create({ data: { workspaceId, provider: this.provider.id, plan: 'free', status: 'active' } })
        .catch(async () => (await this.prisma.billingAccount.findUnique({ where: { workspaceId } }))!);
    }
    let plan = { plan: account.plan, status: account.status };
    if (this.provider.configured) {
      try {
        plan = (await this.provider.getPlan(account.externalCustomerId)) ?? plan;
      } catch (e: any) {
        this.logger.warn(`getPlan failed: ${e?.message}`);
      }
    }
    let portalUrl: string | null = null;
    if (this.provider.configured) {
      portalUrl = await this.provider.portalUrl(account.externalCustomerId, `${env.WEB_PUBLIC_URL}/w/${workspaceId}/settings/usage`).catch(() => null);
    }
    return {
      provider: this.provider.id,
      configured: this.provider.configured,
      message: this.provider.statusMessage,
      plan: plan.plan,
      status: plan.status,
      portalUrl,
    };
  }
}
