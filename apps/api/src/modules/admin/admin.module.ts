import { Module } from '@nestjs/common';
import { AccountService } from './account.service';
import {
  AccountSessionsController,
  AuditController,
  BrandingController,
  InvitationsController,
  MembersController,
  PrivacyController,
  PublicBrandingController,
  TeamsController,
  UsageController,
} from './admin.controllers';
import { AuditLogService } from './audit-log.service';
import { BillingService } from './billing.service';
import { BrandingService } from './branding.service';
import { AdminMaintenanceService } from './maintenance.service';
import { MembersService } from './members.service';
import { PrivacyService } from './privacy.service';
import { TeamsService } from './teams.service';
import { UsageAdminService } from './usage-admin.service';

/**
 * Workstream E — organization admin: members/invitations/roles/teams, branding, audit log,
 * usage/quotas/alerts/billing adapter, privacy (retention, data export/delete), account sessions.
 */
@Module({
  controllers: [
    MembersController,
    InvitationsController,
    TeamsController,
    BrandingController,
    PublicBrandingController,
    AuditController,
    UsageController,
    PrivacyController,
    AccountSessionsController,
  ],
  providers: [
    MembersService,
    TeamsService,
    BrandingService,
    AuditLogService,
    UsageAdminService,
    BillingService,
    PrivacyService,
    AccountService,
    AdminMaintenanceService,
  ],
  exports: [BrandingService, MembersService, BillingService, PrivacyService, UsageAdminService],
})
export class AdminModule {}
