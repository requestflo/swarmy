-- CreateEnum
CREATE TYPE "NotificationChannelKind" AS ENUM ('EMAIL', 'SLACK', 'TEAMS', 'WEBHOOK');

-- CreateEnum
CREATE TYPE "AlertEventStatus" AS ENUM ('FIRING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "IncidentStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "UptimeStatus" AS ENUM ('UP', 'DEGRADED', 'DOWN');

-- CreateEnum
CREATE TYPE "ScheduledJobKind" AS ENUM ('IMAGE', 'SERVICE_EXEC');

-- CreateEnum
CREATE TYPE "JobRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "WorkflowRunStatus" AS ENUM ('RUNNING', 'WAITING_APPROVAL', 'SUCCEEDED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InboundVerifyKind" AS ENUM ('NONE', 'HMAC', 'GITHUB', 'STRIPE');

-- CreateEnum
CREATE TYPE "InboundTargetKind" AS ENUM ('QUEUE', 'FORWARD');

-- CreateEnum
CREATE TYPE "InboundDeliveryStatus" AS ENUM ('PENDING', 'DELIVERED', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "ReleaseStatus" AS ENUM ('DEPLOYING', 'HEALTHY', 'FAILED', 'ROLLED_BACK', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "ImageScanStatus" AS ENUM ('PASSED', 'FAILED', 'ERROR');

-- CreateEnum
CREATE TYPE "NotificationProvider" AS ENUM ('SMTP', 'RESEND', 'POSTMARK', 'MAILGUN');

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('QUEUED', 'SENT', 'FAILED', 'BOUNCED');

-- AlterTable
ALTER TABLE "git_repo" ADD COLUMN     "previewsJson" JSONB;

-- AlterTable
ALTER TABLE "registry_config" ADD COLUMN     "blockCriticalCves" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "cosignPrivateKeyEnc" TEXT,
ADD COLUMN     "cosignPublicKey" TEXT,
ADD COLUMN     "requireSignedImages" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "NotificationChannelKind" NOT NULL,
    "configEnc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_channel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_rule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "selectorJson" JSONB NOT NULL DEFAULT '{}',
    "threshold" DOUBLE PRECISION,
    "forSeconds" INTEGER NOT NULL DEFAULT 0,
    "channelIds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "alert_rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "alert_event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT,
    "signal" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "resource" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "AlertEventStatus" NOT NULL DEFAULT 'FIRING',
    "firedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "alert_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "IncidentStatus" NOT NULL DEFAULT 'OPEN',
    "severity" TEXT NOT NULL DEFAULT 'major',
    "summary" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),

    CONSTRAINT "incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "incident_event" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "incident_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "status_page" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "domain" TEXT,
    "componentsJson" JSONB NOT NULL DEFAULT '[]',
    "showUptime" BOOLEAN NOT NULL DEFAULT true,
    "showIncidents" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "status_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "uptime_sample" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "UptimeStatus" NOT NULL DEFAULT 'UP',

    CONSTRAINT "uptime_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scheduled_job" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "kind" "ScheduledJobKind" NOT NULL DEFAULT 'IMAGE',
    "image" TEXT,
    "serviceRef" TEXT,
    "command" JSONB NOT NULL DEFAULT '[]',
    "envJson" JSONB NOT NULL DEFAULT '{}',
    "runOnJson" JSONB NOT NULL DEFAULT '{}',
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "alertOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "scheduled_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" "JobRunStatus" NOT NULL DEFAULT 'RUNNING',
    "exitCode" INTEGER,
    "outputTail" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "job_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_def" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "stepsJson" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "workflow_def_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "defId" TEXT NOT NULL,
    "status" "WorkflowRunStatus" NOT NULL DEFAULT 'RUNNING',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "stateJson" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "workflow_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_step_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" TIMESTAMPTZ(3),
    "finishedAt" TIMESTAMPTZ(3),
    "outputJson" JSONB,
    "error" TEXT,

    CONSTRAINT "workflow_step_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_endpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "verifyKind" "InboundVerifyKind" NOT NULL DEFAULT 'NONE',
    "verifySecretEnc" TEXT,
    "targetKind" "InboundTargetKind" NOT NULL DEFAULT 'FORWARD',
    "targetJson" JSONB NOT NULL DEFAULT '{}',
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "inbound_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_delivery" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "headersJson" JSONB NOT NULL DEFAULT '{}',
    "bodyText" TEXT NOT NULL,
    "verifyOk" BOOLEAN NOT NULL DEFAULT false,
    "status" "InboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "inbound_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "release" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "composeSource" TEXT NOT NULL,
    "imagesJson" JSONB NOT NULL DEFAULT '[]',
    "actor" TEXT,
    "strategyJson" JSONB NOT NULL DEFAULT '{}',
    "status" "ReleaseStatus" NOT NULL DEFAULT 'DEPLOYING',
    "healthGateJson" JSONB,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_scan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "digest" TEXT,
    "scanner" TEXT NOT NULL DEFAULT 'trivy',
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "reportJson" JSONB NOT NULL DEFAULT '{}',
    "status" "ImageScanStatus" NOT NULL DEFAULT 'PASSED',
    "scannedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "image_scan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "exposure_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL DEFAULT '{}',
    "enforce" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exposure_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guardrail_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL DEFAULT '{}',
    "productionSafetyMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "guardrail_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "NotificationProvider" NOT NULL DEFAULT 'SMTP',
    "configEnc" TEXT,
    "fromAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_provider_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "providersJson" JSONB NOT NULL DEFAULT '[]',
    "configEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_virtual_key" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "appRef" TEXT,
    "limitsJson" JSONB NOT NULL DEFAULT '{}',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_virtual_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inTokens" INTEGER NOT NULL DEFAULT 0,
    "outTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ai_usage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_request_log" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "promptRedacted" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ai_request_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notification_channel_orgId_idx" ON "notification_channel"("orgId");

-- CreateIndex
CREATE INDEX "alert_rule_orgId_enabled_idx" ON "alert_rule"("orgId", "enabled");

-- CreateIndex
CREATE INDEX "alert_event_orgId_status_firedAt_idx" ON "alert_event"("orgId", "status", "firedAt");

-- CreateIndex
CREATE INDEX "alert_event_ruleId_resource_status_idx" ON "alert_event"("ruleId", "resource", "status");

-- CreateIndex
CREATE INDEX "incident_orgId_status_openedAt_idx" ON "incident"("orgId", "status", "openedAt");

-- CreateIndex
CREATE INDEX "incident_event_orgId_idx" ON "incident_event"("orgId");

-- CreateIndex
CREATE INDEX "incident_event_incidentId_at_idx" ON "incident_event"("incidentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "status_page_slug_key" ON "status_page"("slug");

-- CreateIndex
CREATE INDEX "status_page_orgId_idx" ON "status_page"("orgId");

-- CreateIndex
CREATE INDEX "uptime_sample_orgId_at_idx" ON "uptime_sample"("orgId", "at");

-- CreateIndex
CREATE INDEX "uptime_sample_pageId_componentKey_at_idx" ON "uptime_sample"("pageId", "componentKey", "at");

-- CreateIndex
CREATE INDEX "scheduled_job_orgId_idx" ON "scheduled_job"("orgId");

-- CreateIndex
CREATE INDEX "scheduled_job_enabled_lastRunAt_idx" ON "scheduled_job"("enabled", "lastRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_job_orgId_name_key" ON "scheduled_job"("orgId", "name");

-- CreateIndex
CREATE INDEX "job_run_orgId_startedAt_idx" ON "job_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "job_run_jobId_startedAt_idx" ON "job_run"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_def_orgId_idx" ON "workflow_def"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_def_orgId_name_version_key" ON "workflow_def"("orgId", "name", "version");

-- CreateIndex
CREATE INDEX "workflow_run_orgId_startedAt_idx" ON "workflow_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_run_defId_startedAt_idx" ON "workflow_run"("defId", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_run_status_idx" ON "workflow_run"("status");

-- CreateIndex
CREATE INDEX "workflow_step_run_orgId_idx" ON "workflow_step_run"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "workflow_step_run_runId_index_key" ON "workflow_step_run"("runId", "index");

-- CreateIndex
CREATE INDEX "inbound_endpoint_orgId_idx" ON "inbound_endpoint"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_endpoint_orgId_slug_key" ON "inbound_endpoint"("orgId", "slug");

-- CreateIndex
CREATE INDEX "inbound_delivery_orgId_receivedAt_idx" ON "inbound_delivery"("orgId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_delivery_endpointId_receivedAt_idx" ON "inbound_delivery"("endpointId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_delivery_status_nextAttemptAt_idx" ON "inbound_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "release_orgId_stackName_createdAt_idx" ON "release"("orgId", "stackName", "createdAt");

-- CreateIndex
CREATE INDEX "release_orgId_status_idx" ON "release"("orgId", "status");

-- CreateIndex
CREATE INDEX "image_scan_orgId_scannedAt_idx" ON "image_scan"("orgId", "scannedAt");

-- CreateIndex
CREATE INDEX "image_scan_orgId_imageRef_idx" ON "image_scan"("orgId", "imageRef");

-- CreateIndex
CREATE INDEX "image_scan_digest_idx" ON "image_scan"("digest");

-- CreateIndex
CREATE UNIQUE INDEX "exposure_config_orgId_key" ON "exposure_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "guardrail_config_orgId_key" ON "guardrail_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_config_orgId_key" ON "notification_config"("orgId");

-- CreateIndex
CREATE INDEX "notification_template_orgId_idx" ON "notification_template"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_orgId_name_key" ON "notification_template"("orgId", "name");

-- CreateIndex
CREATE INDEX "notification_delivery_orgId_createdAt_idx" ON "notification_delivery"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_delivery_status_createdAt_idx" ON "notification_delivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ai_provider_config_orgId_key" ON "ai_provider_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_virtual_key_keyHash_key" ON "ai_virtual_key"("keyHash");

-- CreateIndex
CREATE INDEX "ai_virtual_key_orgId_idx" ON "ai_virtual_key"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ai_virtual_key_orgId_name_key" ON "ai_virtual_key"("orgId", "name");

-- CreateIndex
CREATE INDEX "ai_usage_orgId_at_idx" ON "ai_usage"("orgId", "at");

-- CreateIndex
CREATE INDEX "ai_usage_keyId_at_idx" ON "ai_usage"("keyId", "at");

-- CreateIndex
CREATE INDEX "ai_request_log_orgId_at_idx" ON "ai_request_log"("orgId", "at");

-- CreateIndex
CREATE INDEX "ai_request_log_keyId_at_idx" ON "ai_request_log"("keyId", "at");

-- AddForeignKey
ALTER TABLE "notification_channel" ADD CONSTRAINT "notification_channel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_rule" ADD CONSTRAINT "alert_rule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alert_event" ADD CONSTRAINT "alert_event_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident" ADD CONSTRAINT "incident_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "incident_event" ADD CONSTRAINT "incident_event_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "status_page" ADD CONSTRAINT "status_page_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uptime_sample" ADD CONSTRAINT "uptime_sample_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "uptime_sample" ADD CONSTRAINT "uptime_sample_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "status_page"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scheduled_job" ADD CONSTRAINT "scheduled_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_run" ADD CONSTRAINT "job_run_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_def" ADD CONSTRAINT "workflow_def_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_run" ADD CONSTRAINT "workflow_run_defId_fkey" FOREIGN KEY ("defId") REFERENCES "workflow_def"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_run" ADD CONSTRAINT "workflow_step_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_step_run" ADD CONSTRAINT "workflow_step_run_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_endpoint" ADD CONSTRAINT "inbound_endpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_delivery" ADD CONSTRAINT "inbound_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_delivery" ADD CONSTRAINT "inbound_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "inbound_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "release" ADD CONSTRAINT "release_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_scan" ADD CONSTRAINT "image_scan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "exposure_config" ADD CONSTRAINT "exposure_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guardrail_config" ADD CONSTRAINT "guardrail_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_config" ADD CONSTRAINT "notification_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_template" ADD CONSTRAINT "notification_template_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_provider_config" ADD CONSTRAINT "ai_provider_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_virtual_key" ADD CONSTRAINT "ai_virtual_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ai_virtual_key"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_request_log" ADD CONSTRAINT "ai_request_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_request_log" ADD CONSTRAINT "ai_request_log_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ai_virtual_key"("id") ON DELETE CASCADE ON UPDATE CASCADE;

