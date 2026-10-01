-- Scenario Studio: the drafting assistant becomes a persisted conversation. Each proposal row is one
-- exchange (creator message = instruction, assistant reply + questions + unsupported requests + fields
-- left alone). Additive only.
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "reply" TEXT NOT NULL DEFAULT '';
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "questions" TEXT[] DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "unsupported" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "DraftAssistantProposal" ADD COLUMN "preserved" JSONB NOT NULL DEFAULT '[]';
