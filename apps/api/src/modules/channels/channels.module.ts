import { Module } from '@nestjs/common';
import { RuntimeModule } from '../runtime/runtime.module';
import { BatchesService } from './batches.service';
import { ChannelProvidersService } from './channel-providers.service';
import { ChannelsController, ChannelsJobs, ChannelWebhooksController } from './channels.controller';
import { MeetingsService } from './meetings.service';
import { PhoneNumbersService } from './phone-numbers.service';
import { PhoneService } from './phone.service';
import { TwilioMediaGateway } from './twilio/twilio-media.gateway';

/**
 * Channels (workstream H): phone via Twilio (inbound/outbound calls, media-stream bridge to the
 * session engine, transfer, batch/scheduled calling) and meeting bots via Recall.ai.
 * Real adapters only: missing credentials surface as BLOCKED / provider_unavailable with the exact reason.
 */
@Module({
  imports: [RuntimeModule],
  controllers: [ChannelsController, ChannelWebhooksController],
  providers: [ChannelProvidersService, PhoneNumbersService, PhoneService, BatchesService, MeetingsService, TwilioMediaGateway, ChannelsJobs],
  exports: [ChannelProvidersService, PhoneService],
})
export class ChannelsModule {}
