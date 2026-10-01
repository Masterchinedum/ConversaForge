-- Scenario Studio agent runs: the assistant edits the draft in visible steps. Additive only.
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'review';
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "events" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "cancelRequested" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "finishedAt" TIMESTAMP(3);
