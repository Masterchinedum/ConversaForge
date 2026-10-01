-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WorkspaceKind" AS ENUM ('PERSONAL', 'ORGANIZATION');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'ADMIN', 'CREATOR', 'REVIEWER', 'MEMBER');

-- CreateEnum
CREATE TYPE "UsageKind" AS ENUM ('SESSION_SECONDS', 'LLM_INPUT_TOKENS', 'LLM_OUTPUT_TOKENS', 'STT_SECONDS', 'TTS_CHARACTERS', 'REALTIME_SECONDS', 'ANALYSIS_INPUT_TOKENS', 'ANALYSIS_OUTPUT_TOKENS', 'STORAGE_BYTES', 'TELEPHONY_SECONDS', 'EMBEDDING_TOKENS');

-- CreateEnum
CREATE TYPE "Privacy" AS ENUM ('PRIVATE', 'ORGANIZATION', 'PUBLIC');

-- CreateEnum
CREATE TYPE "ScenarioStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GranteeType" AS ENUM ('USER', 'EMAIL', 'WORKSPACE');

-- CreateEnum
CREATE TYPE "GrantPermission" AS ENUM ('RUN', 'VIEW_RESULTS', 'EDIT');

-- CreateEnum
CREATE TYPE "LinkMode" AS ENUM ('MULTI_USE', 'ONE_TIME');

-- CreateEnum
CREATE TYPE "IdentityMode" AS ENUM ('NONE', 'NAME', 'EMAIL', 'NAME_EMAIL');

-- CreateEnum
CREATE TYPE "AccessTokenPurpose" AS ENUM ('EMBED', 'PARTICIPANT');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('BROWSER', 'EMBED', 'PHONE_INBOUND', 'PHONE_OUTBOUND', 'MEETING', 'API');

-- CreateEnum
CREATE TYPE "SessionState" AS ENUM ('CREATED', 'READY', 'CONNECTING', 'ACTIVE', 'PAUSED', 'RECONNECTING', 'ENDING', 'COMPLETED', 'FAILED', 'CANCELLED', 'EXPIRED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ProcessingStatus" AS ENUM ('NOT_STARTED', 'QUEUED', 'PROCESSING', 'COMPLETED', 'PARTIAL', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "Speaker" AS ENUM ('AGENT', 'PARTICIPANT', 'SYSTEM');

-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('RECORDING_AUDIO', 'RECORDING_VIDEO', 'KNOWLEDGE_DOCUMENT', 'TOOL_UPLOAD', 'BRANDING', 'COURSE_ASSET', 'EXPORT');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "CourseItemKind" AS ENUM ('SCENARIO', 'VIDEO', 'DOCUMENT', 'LINK');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "passwordHash" TEXT,
    "emailVerifiedAt" TIMESTAMP(3),
    "avatarUrl" TEXT,
    "isSuperAdmin" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuthSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "kind" "WorkspaceKind" NOT NULL DEFAULT 'ORGANIZATION',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invitation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'MEMBER',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "acceptedById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TeamMember" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceBranding" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "displayName" TEXT,
    "logoAssetId" TEXT,
    "logoUrl" TEXT,
    "primaryColor" TEXT,
    "accentColor" TEXT,
    "supportEmail" TEXT,
    "emailFooter" TEXT,
    "hidePoweredBy" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceBranding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "actorUserId" TEXT,
    "actorApiKeyId" TEXT,
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "createdById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER,
    "responseBody" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageLedger" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" "UsageKind" NOT NULL,
    "provider" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "idempotencyKey" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageLedger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkspaceQuota" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "period" TEXT NOT NULL DEFAULT 'month',
    "limitValue" DOUBLE PRECISION NOT NULL,
    "alertThresholdPct" INTEGER NOT NULL DEFAULT 80,
    "hardLimit" BOOLEAN NOT NULL DEFAULT true,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkspaceQuota_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UsageAlert" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "thresholdPct" INTEGER NOT NULL,
    "valueAtTrigger" DOUBLE PRECISION NOT NULL,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UsageAlert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'none',
    "externalCustomerId" TEXT,
    "plan" TEXT NOT NULL DEFAULT 'free',
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Scenario" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "privacy" "Privacy" NOT NULL DEFAULT 'PRIVATE',
    "status" "ScenarioStatus" NOT NULL DEFAULT 'DRAFT',
    "isTemplate" BOOLEAN NOT NULL DEFAULT false,
    "galleryListed" BOOLEAN NOT NULL DEFAULT false,
    "tags" TEXT[],
    "publicDescription" TEXT,
    "latestVersionId" TEXT,
    "latestVersionNumber" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Scenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioDraft" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "lockedFields" TEXT[],
    "baseVersionId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScenarioDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioVersion" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "config" JSONB NOT NULL,
    "configHash" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "changeNote" TEXT,
    "rolledBackFromVersionId" TEXT,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DraftAssistantProposal" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "draftRevision" INTEGER NOT NULL,
    "instruction" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "appliedPaths" TEXT[],
    "provider" TEXT,
    "model" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "dropped" JSONB NOT NULL DEFAULT '[]',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "DraftAssistantProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScenarioGrant" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "granteeType" "GranteeType" NOT NULL,
    "granteeUserId" TEXT,
    "granteeEmail" TEXT,
    "granteeWorkspaceId" TEXT,
    "permission" "GrantPermission" NOT NULL DEFAULT 'RUN',
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScenarioGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShareLink" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "label" TEXT,
    "pinnedVersionId" TEXT,
    "mode" "LinkMode" NOT NULL DEFAULT 'MULTI_USE',
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3),
    "passcodeHash" TEXT,
    "perEmailAttemptLimit" INTEGER,
    "identityMode" "IdentityMode" NOT NULL DEFAULT 'NAME_EMAIL',
    "allowedEmailDomains" TEXT[],
    "prefilledVariables" JSONB NOT NULL DEFAULT '{}',
    "courseId" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShareLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccessToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "pinnedVersionId" TEXT,
    "purpose" "AccessTokenPurpose" NOT NULL DEFAULT 'EMBED',
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "participantExternalId" TEXT,
    "participantEmail" TEXT,
    "participantName" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "allowedOrigins" TEXT[],
    "maxUses" INTEGER,
    "useCount" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdByApiKeyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Participant" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT,
    "email" TEXT,
    "name" TEXT,
    "externalId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Participant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "scenarioVersionId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL DEFAULT 'BROWSER',
    "state" "SessionState" NOT NULL DEFAULT 'CREATED',
    "stateReason" TEXT,
    "endedBy" TEXT,
    "shareLinkId" TEXT,
    "accessTokenId" TEXT,
    "enrollmentId" TEXT,
    "courseItemAttemptId" TEXT,
    "coachMode" BOOLEAN NOT NULL DEFAULT false,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "consent" JSONB NOT NULL DEFAULT '{}',
    "providerInfo" JSONB NOT NULL DEFAULT '{}',
    "runtimeState" JSONB NOT NULL DEFAULT '{}',
    "resumeTokenHash" TEXT,
    "resumeExpiresAt" TIMESTAMP(3),
    "maxDurationSec" INTEGER NOT NULL DEFAULT 1800,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationMs" INTEGER,
    "lastSeq" INTEGER NOT NULL DEFAULT 0,
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "analysisStatus" "ProcessingStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "analysisError" TEXT,
    "analysisGeneration" INTEGER NOT NULL DEFAULT 0,
    "usageFinalizedAt" TIMESTAMP(3),
    "externalRef" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "contentRedactedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TranscriptTurn" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "speaker" "Speaker" NOT NULL,
    "text" TEXT NOT NULL,
    "clientTurnId" TEXT,
    "startedAtMs" INTEGER,
    "endedAtMs" INTEGER,
    "interrupted" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "source" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" "MediaKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL DEFAULT 0,
    "sha256" TEXT,
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "durationMs" INTEGER,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdById" TEXT,
    "retentionUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MediaUploadPart" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "partNumber" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MediaUploadPart_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolEvent" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "toolId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "args" JSONB NOT NULL DEFAULT '{}',
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessingJob" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sessionId" TEXT,
    "kind" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "ProcessingJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioVersionId" TEXT NOT NULL,
    "rubricHash" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "overallScore" DOUBLE PRECISION,
    "scoredWeightPct" DOUBLE PRECISION,
    "insufficientEvidence" BOOLEAN NOT NULL DEFAULT false,
    "summary" TEXT,
    "strengths" JSONB NOT NULL DEFAULT '[]',
    "weaknesses" JSONB NOT NULL DEFAULT '[]',
    "improvements" JSONB NOT NULL DEFAULT '[]',
    "notes" JSONB NOT NULL DEFAULT '[]',
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "humanReviewRequired" BOOLEAN NOT NULL DEFAULT false,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "error" TEXT,
    "generation" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CriterionScore" (
    "id" TEXT NOT NULL,
    "evaluationId" TEXT NOT NULL,
    "criterionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "weight" DOUBLE PRECISION NOT NULL,
    "score" DOUBLE PRECISION,
    "insufficientEvidence" BOOLEAN NOT NULL DEFAULT false,
    "confidence" DOUBLE PRECISION,
    "rationale" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CriterionScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionResult" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioVersionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" JSONB,
    "valid" BOOLEAN NOT NULL DEFAULT true,
    "errors" TEXT[],
    "evidence" JSONB NOT NULL DEFAULT '[]',
    "confidence" DOUBLE PRECISION,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SessionReport" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SessionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoachProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "memoryEnabled" BOOLEAN NOT NULL DEFAULT true,
    "goals" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CoachProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MemoryFact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "coachProfileId" TEXT NOT NULL,
    "scenarioId" TEXT,
    "sourceSessionId" TEXT,
    "category" TEXT NOT NULL DEFAULT 'general',
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "simulated" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "MemoryFact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Course" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverUrl" TEXT,
    "coverAssetId" TEXT,
    "forcedOrder" BOOLEAN NOT NULL DEFAULT false,
    "visibility" "Privacy" NOT NULL DEFAULT 'PRIVATE',
    "status" "ScenarioStatus" NOT NULL DEFAULT 'DRAFT',
    "shareToken" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Course_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseItem" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "kind" "CourseItemKind" NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scenarioId" TEXT,
    "pinnedVersionId" TEXT,
    "url" TEXT,
    "assetId" TEXT,
    "completionRule" JSONB NOT NULL DEFAULT '{}',
    "required" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CourseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "participantId" TEXT NOT NULL,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "generation" INTEGER NOT NULL DEFAULT 1,
    "assignedById" TEXT,
    "lastItemId" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CourseItemAttempt" (
    "id" TEXT NOT NULL,
    "enrollmentId" TEXT NOT NULL,
    "courseItemId" TEXT NOT NULL,
    "generation" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'STARTED',
    "sessionId" TEXT,
    "score" DOUBLE PRECISION,
    "statusReason" TEXT,
    "evaluationId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "CourseItemAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "assetId" TEXT,
    "sourceUrl" TEXT,
    "mimeType" TEXT NOT NULL,
    "status" "ProcessingStatus" NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "pageCount" INTEGER,
    "chunkCount" INTEGER NOT NULL DEFAULT 0,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeChunk" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "page" INTEGER,
    "heading" TEXT,
    "tokenCount" INTEGER NOT NULL DEFAULT 0,
    "tsv" tsvector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeChunk_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT,
    "encryptedSecret" TEXT NOT NULL,
    "secretLast4" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastVerifiedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "ProviderConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFunction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "parametersSchema" JSONB NOT NULL,
    "url" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'POST',
    "encryptedHeaders" TEXT,
    "allowedHosts" TEXT[],
    "timeoutMs" INTEGER NOT NULL DEFAULT 8000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "CustomFunction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "encryptedSecret" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "disabledAt" TIMESTAMP(3),
    "previousEncryptedSecret" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastStatusCode" INTEGER,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDeliveryAttempt" (
    "id" TEXT NOT NULL,
    "deliveryId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL,
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "statusCode" INTEGER,
    "error" TEXT,
    "responseSnippet" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDeliveryAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PhoneNumber" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "providerConnectionId" TEXT,
    "provider" TEXT NOT NULL,
    "e164" TEXT NOT NULL,
    "inboundScenarioId" TEXT,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PhoneNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundCallBatch" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fromNumberId" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "concurrency" INTEGER NOT NULL DEFAULT 1,
    "statusReason" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundCallBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundCallTarget" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "sessionId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "callSid" TEXT,
    "externalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundCallTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MeetingBot" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "meetingUrl" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3),
    "calendarEventId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "providerBotId" TEXT,
    "sessionId" TEXT,
    "lastError" TEXT,
    "botName" TEXT,
    "evaluatedSpeakerName" TEXT,
    "lastEventAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MeetingBot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DataRequest" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "participantId" TEXT,
    "subjectEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resultAssetId" TEXT,
    "requestedById" TEXT,
    "error" TEXT,
    "summary" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DataRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AuthSession_tokenHash_key" ON "AuthSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AuthSession_userId_idx" ON "AuthSession"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- CreateIndex
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_slug_key" ON "Workspace"("slug");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_workspaceId_userId_key" ON "Membership"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Invitation_tokenHash_key" ON "Invitation"("tokenHash");

-- CreateIndex
CREATE INDEX "Invitation_workspaceId_email_idx" ON "Invitation"("workspaceId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "Team_workspaceId_name_key" ON "Team"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "TeamMember_participantId_idx" ON "TeamMember"("participantId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamMember_teamId_participantId_key" ON "TeamMember"("teamId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceBranding_workspaceId_key" ON "WorkspaceBranding"("workspaceId");

-- CreateIndex
CREATE INDEX "AuditLog_workspaceId_createdAt_idx" ON "AuditLog"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_targetId_idx" ON "AuditLog"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_prefix_key" ON "ApiKey"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");

-- CreateIndex
CREATE INDEX "ApiKey_workspaceId_idx" ON "ApiKey"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_scope_key_key" ON "IdempotencyRecord"("scope", "key");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE UNIQUE INDEX "UsageLedger_idempotencyKey_key" ON "UsageLedger"("idempotencyKey");

-- CreateIndex
CREATE INDEX "UsageLedger_workspaceId_createdAt_idx" ON "UsageLedger"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "UsageLedger_sessionId_idx" ON "UsageLedger"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkspaceQuota_workspaceId_metric_period_key" ON "WorkspaceQuota"("workspaceId", "metric", "period");

-- CreateIndex
CREATE UNIQUE INDEX "UsageAlert_workspaceId_metric_periodKey_thresholdPct_key" ON "UsageAlert"("workspaceId", "metric", "periodKey", "thresholdPct");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccount_workspaceId_key" ON "BillingAccount"("workspaceId");

-- CreateIndex
CREATE INDEX "Scenario_workspaceId_status_idx" ON "Scenario"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Scenario_privacy_galleryListed_idx" ON "Scenario"("privacy", "galleryListed");

-- CreateIndex
CREATE UNIQUE INDEX "Scenario_workspaceId_slug_key" ON "Scenario"("workspaceId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioDraft_scenarioId_key" ON "ScenarioDraft"("scenarioId");

-- CreateIndex
CREATE INDEX "ScenarioVersion_workspaceId_idx" ON "ScenarioVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ScenarioVersion_scenarioId_version_key" ON "ScenarioVersion"("scenarioId", "version");

-- CreateIndex
CREATE INDEX "DraftAssistantProposal_scenarioId_createdAt_idx" ON "DraftAssistantProposal"("scenarioId", "createdAt");

-- CreateIndex
CREATE INDEX "ScenarioGrant_scenarioId_idx" ON "ScenarioGrant"("scenarioId");

-- CreateIndex
CREATE INDEX "ScenarioGrant_granteeEmail_idx" ON "ScenarioGrant"("granteeEmail");

-- CreateIndex
CREATE INDEX "ScenarioGrant_granteeUserId_idx" ON "ScenarioGrant"("granteeUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ShareLink_token_key" ON "ShareLink"("token");

-- CreateIndex
CREATE INDEX "ShareLink_scenarioId_idx" ON "ShareLink"("scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "AccessToken_tokenHash_key" ON "AccessToken"("tokenHash");

-- CreateIndex
CREATE INDEX "AccessToken_workspaceId_idx" ON "AccessToken"("workspaceId");

-- CreateIndex
CREATE INDEX "Participant_workspaceId_email_idx" ON "Participant"("workspaceId", "email");

-- CreateIndex
CREATE INDEX "Participant_workspaceId_userId_idx" ON "Participant"("workspaceId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Participant_workspaceId_externalId_key" ON "Participant"("workspaceId", "externalId");

-- CreateIndex
CREATE INDEX "Session_workspaceId_createdAt_idx" ON "Session"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_scenarioId_createdAt_idx" ON "Session"("scenarioId", "createdAt");

-- CreateIndex
CREATE INDEX "Session_participantId_idx" ON "Session"("participantId");

-- CreateIndex
CREATE INDEX "Session_state_idx" ON "Session"("state");

-- CreateIndex
CREATE INDEX "Session_shareLinkId_idx" ON "Session"("shareLinkId");

-- CreateIndex
CREATE INDEX "Session_externalRef_idx" ON "Session"("externalRef");

-- CreateIndex
CREATE INDEX "SessionEvent_sessionId_createdAt_idx" ON "SessionEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptTurn_sessionId_seq_key" ON "TranscriptTurn"("sessionId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptTurn_sessionId_clientTurnId_key" ON "TranscriptTurn"("sessionId", "clientTurnId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaAsset_storageKey_key" ON "MediaAsset"("storageKey");

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_kind_idx" ON "MediaAsset"("workspaceId", "kind");

-- CreateIndex
CREATE INDEX "MediaAsset_sessionId_idx" ON "MediaAsset"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "MediaUploadPart_assetId_partNumber_key" ON "MediaUploadPart"("assetId", "partNumber");

-- CreateIndex
CREATE INDEX "ToolEvent_sessionId_createdAt_idx" ON "ToolEvent"("sessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ToolEvent_sessionId_toolCallId_kind_key" ON "ToolEvent"("sessionId", "toolCallId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessingJob_idempotencyKey_key" ON "ProcessingJob"("idempotencyKey");

-- CreateIndex
CREATE INDEX "ProcessingJob_sessionId_idx" ON "ProcessingJob"("sessionId");

-- CreateIndex
CREATE INDEX "ProcessingJob_workspaceId_status_idx" ON "ProcessingJob"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Evaluation_sessionId_idx" ON "Evaluation"("sessionId");

-- CreateIndex
CREATE INDEX "Evaluation_workspaceId_createdAt_idx" ON "Evaluation"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Evaluation_sessionId_generation_key" ON "Evaluation"("sessionId", "generation");

-- CreateIndex
CREATE UNIQUE INDEX "CriterionScore_evaluationId_criterionId_key" ON "CriterionScore"("evaluationId", "criterionId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionResult_sessionId_key_key" ON "ExtractionResult"("sessionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "SessionReport_sessionId_key" ON "SessionReport"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "CoachProfile_workspaceId_participantId_key" ON "CoachProfile"("workspaceId", "participantId");

-- CreateIndex
CREATE INDEX "MemoryFact_workspaceId_participantId_idx" ON "MemoryFact"("workspaceId", "participantId");

-- CreateIndex
CREATE INDEX "MemoryFact_sourceSessionId_idx" ON "MemoryFact"("sourceSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "Course_shareToken_key" ON "Course"("shareToken");

-- CreateIndex
CREATE INDEX "Course_workspaceId_idx" ON "Course"("workspaceId");

-- CreateIndex
CREATE INDEX "CourseItem_courseId_position_idx" ON "CourseItem"("courseId", "position");

-- CreateIndex
CREATE INDEX "Enrollment_workspaceId_idx" ON "Enrollment"("workspaceId");

-- CreateIndex
CREATE INDEX "Enrollment_userId_idx" ON "Enrollment"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_courseId_participantId_key" ON "Enrollment"("courseId", "participantId");

-- CreateIndex
CREATE UNIQUE INDEX "CourseItemAttempt_sessionId_key" ON "CourseItemAttempt"("sessionId");

-- CreateIndex
CREATE INDEX "CourseItemAttempt_enrollmentId_courseItemId_generation_idx" ON "CourseItemAttempt"("enrollmentId", "courseItemId", "generation");

-- CreateIndex
CREATE INDEX "KnowledgeDocument_workspaceId_idx" ON "KnowledgeDocument"("workspaceId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_workspaceId_idx" ON "KnowledgeChunk"("workspaceId");

-- CreateIndex
CREATE INDEX "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeChunk_documentId_ordinal_key" ON "KnowledgeChunk"("documentId", "ordinal");

-- CreateIndex
CREATE INDEX "ProviderConnection_workspaceId_kind_idx" ON "ProviderConnection"("workspaceId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFunction_workspaceId_name_key" ON "CustomFunction"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "OutboxEvent_workspaceId_createdAt_idx" ON "OutboxEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookSubscription_workspaceId_idx" ON "WebhookSubscription"("workspaceId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_workspaceId_createdAt_idx" ON "WebhookDelivery"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_subscriptionId_eventId_key" ON "WebhookDelivery"("subscriptionId", "eventId");

-- CreateIndex
CREATE INDEX "WebhookDeliveryAttempt_workspaceId_createdAt_idx" ON "WebhookDeliveryAttempt"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDeliveryAttempt_deliveryId_attempt_key" ON "WebhookDeliveryAttempt"("deliveryId", "attempt");

-- CreateIndex
CREATE INDEX "PhoneNumber_workspaceId_idx" ON "PhoneNumber"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PhoneNumber_provider_e164_key" ON "PhoneNumber"("provider", "e164");

-- CreateIndex
CREATE INDEX "OutboundCallBatch_workspaceId_idx" ON "OutboundCallBatch"("workspaceId");

-- CreateIndex
CREATE INDEX "OutboundCallTarget_batchId_status_idx" ON "OutboundCallTarget"("batchId", "status");

-- CreateIndex
CREATE INDEX "MeetingBot_workspaceId_idx" ON "MeetingBot"("workspaceId");

-- CreateIndex
CREATE INDEX "DataRequest_workspaceId_idx" ON "DataRequest"("workspaceId");

-- AddForeignKey
ALTER TABLE "AuthSession" ADD CONSTRAINT "AuthSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TeamMember" ADD CONSTRAINT "TeamMember_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkspaceBranding" ADD CONSTRAINT "WorkspaceBranding_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Scenario" ADD CONSTRAINT "Scenario_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioDraft" ADD CONSTRAINT "ScenarioDraft_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioVersion" ADD CONSTRAINT "ScenarioVersion_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScenarioGrant" ADD CONSTRAINT "ScenarioGrant_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShareLink" ADD CONSTRAINT "ShareLink_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_scenarioId_fkey" FOREIGN KEY ("scenarioId") REFERENCES "Scenario"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_scenarioVersionId_fkey" FOREIGN KEY ("scenarioVersionId") REFERENCES "ScenarioVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_participantId_fkey" FOREIGN KEY ("participantId") REFERENCES "Participant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptTurn" ADD CONSTRAINT "TranscriptTurn_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaUploadPart" ADD CONSTRAINT "MediaUploadPart_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "MediaAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolEvent" ADD CONSTRAINT "ToolEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evaluation" ADD CONSTRAINT "Evaluation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CriterionScore" ADD CONSTRAINT "CriterionScore_evaluationId_fkey" FOREIGN KEY ("evaluationId") REFERENCES "Evaluation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionResult" ADD CONSTRAINT "ExtractionResult_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MemoryFact" ADD CONSTRAINT "MemoryFact_coachProfileId_fkey" FOREIGN KEY ("coachProfileId") REFERENCES "CoachProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseItem" ADD CONSTRAINT "CourseItem_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseItemAttempt" ADD CONSTRAINT "CourseItemAttempt_enrollmentId_fkey" FOREIGN KEY ("enrollmentId") REFERENCES "Enrollment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CourseItemAttempt" ADD CONSTRAINT "CourseItemAttempt_courseItemId_fkey" FOREIGN KEY ("courseItemId") REFERENCES "CourseItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeChunk" ADD CONSTRAINT "KnowledgeChunk_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "KnowledgeDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDeliveryAttempt" ADD CONSTRAINT "WebhookDeliveryAttempt_deliveryId_fkey" FOREIGN KEY ("deliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundCallTarget" ADD CONSTRAINT "OutboundCallTarget_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "OutboundCallBatch"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ─── Raw SQL objects (from prisma/sql/post-push.sql) ───
-- Idempotent database objects that Prisma's schema language cannot express.
-- Applied by `pnpm db:sync` in development and included in the initial migration for production.

-- 1) Published scenario versions are immutable snapshots: block every UPDATE.
CREATE OR REPLACE FUNCTION cf_prevent_scenario_version_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ScenarioVersion % is immutable; publish a new version instead', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS cf_scenario_version_immutable ON "ScenarioVersion";
CREATE TRIGGER cf_scenario_version_immutable
  BEFORE UPDATE ON "ScenarioVersion"
  FOR EACH ROW EXECUTE FUNCTION cf_prevent_scenario_version_update();

-- 2) Full-text search column for knowledge chunks (generated, GIN-indexed).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'KnowledgeChunk' AND column_name = 'tsv' AND is_generated = 'NEVER'
  ) THEN
    ALTER TABLE "KnowledgeChunk" DROP COLUMN "tsv";
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_name = 'KnowledgeChunk' AND column_name = 'tsv'
  ) THEN
    ALTER TABLE "KnowledgeChunk" ADD COLUMN "tsv" tsvector
      GENERATED ALWAYS AS (to_tsvector('english', coalesce("heading", '') || ' ' || "text")) STORED;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "KnowledgeChunk_tsv_idx" ON "KnowledgeChunk" USING GIN ("tsv");

-- 3) Transcript turns are append-only per session sequence (dedupe enforced by unique indexes).
