-- CreateTable
CREATE TABLE "auth_provider_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "encryptedSecret" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "sso_provider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "domain" TEXT,
    "issuer" TEXT,
    "clientId" TEXT,
    "encryptedSecret" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sso_provider_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isdefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "resource_grant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "resource_grant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "org_security_policy" (
    "orgId" TEXT NOT NULL PRIMARY KEY,
    "require2fa" TEXT NOT NULL DEFAULT 'off',
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "enforcedSince" DATETIME,
    "trustIdpMfa" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "org_security_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_provider_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "providersJson" JSONB NOT NULL DEFAULT '[]',
    "configEnc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ai_provider_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_virtual_key" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "appRef" TEXT,
    "limitsJson" JSONB NOT NULL DEFAULT '{}',
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ai_virtual_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_usage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inTokens" INTEGER NOT NULL DEFAULT 0,
    "outTokens" INTEGER NOT NULL DEFAULT 0,
    "costMicros" BIGINT NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "cacheHit" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "ai_usage_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_usage_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ai_virtual_key" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ai_request_log" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "model" TEXT NOT NULL,
    "promptRedacted" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "ai_request_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ai_request_log_keyId_fkey" FOREIGN KEY ("keyId") REFERENCES "ai_virtual_key" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_channel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "configEnc" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_channel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "alert_rule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "signal" TEXT NOT NULL,
    "selectorJson" JSONB NOT NULL DEFAULT '{}',
    "threshold" REAL,
    "forSeconds" INTEGER NOT NULL DEFAULT 0,
    "channelIds" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "optedOutAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "alert_rule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "alert_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT,
    "signal" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "resource" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FIRING',
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "alert_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "alert_event_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "incident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "severity" TEXT NOT NULL DEFAULT 'major',
    "summary" TEXT,
    "openedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "incident_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "incident_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "incidentId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "kind" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "meta" JSONB NOT NULL DEFAULT '{}',
    CONSTRAINT "incident_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "incident_event_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "incident" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "status_page" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "stackName" TEXT,
    "domain" TEXT,
    "componentsJson" JSONB NOT NULL DEFAULT '[]',
    "showUptime" BOOLEAN NOT NULL DEFAULT true,
    "showIncidents" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "status_page_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "uptime_sample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "pageId" TEXT NOT NULL,
    "componentKey" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'UP',
    CONSTRAINT "uptime_sample_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "uptime_sample_pageId_fkey" FOREIGN KEY ("pageId") REFERENCES "status_page" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["read"]',
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "createdById" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "api_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "api_key_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["read"]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "revokedAt" DATETIME,
    CONSTRAINT "oauth_client_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "webhook_endpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" DATETIME,
    CONSTRAINT "webhook_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "webhook_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "displayUsername" TEXT,
    "image" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "activeOrganizationId" TEXT,
    "mfaVerifiedAt" DATETIME,
    "mfaPending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" DATETIME,
    "refreshTokenExpiresAt" DATETIME,
    "scope" TEXT,
    "password" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" DATETIME NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_target" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'S3',
    "endpoint" TEXT,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT,
    "region" TEXT,
    "credentialRef" TEXT,
    "secretKeyRef" TEXT,
    "resticPasswordRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "backup_target_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "resticId" TEXT,
    "sizeBytes" BIGINT,
    "error" TEXT,
    "hostNodeId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "snapshot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "snapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "controller_backup_config" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'controller',
    "targetId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schedule" TEXT NOT NULL DEFAULT '0 3 * * *',
    "retention" JSONB NOT NULL DEFAULT '{"keepDaily":7,"keepWeekly":4,"keepMonthly":3}',
    "restorePassphraseRef" TEXT,
    "restorePassphraseHint" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "controller_backup_config_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "controller_snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "resticSnapshotId" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "manifestJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "error" TEXT,
    CONSTRAINT "controller_snapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "storage_cluster" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'NONE',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "replicationFactor" INTEGER NOT NULL DEFAULT 3,
    "region" TEXT NOT NULL DEFAULT 'swarmy',
    "memberNodeIds" JSONB NOT NULL DEFAULT '[]',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "rpcSecretRef" TEXT,
    "adminTokenRef" TEXT,
    "accessKeyRef" TEXT,
    "secretKeyRef" TEXT,
    "publicS3Domain" TEXT,
    "engineImage" TEXT,
    "engineUpgrade" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "storage_cluster_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "bucket_access" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "bucketName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'INTERNAL',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "backup_schedule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "nodeId" TEXT,
    "every" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "retentionDays" INTEGER,
    "anchorAt" DATETIME,
    "optedOutAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "backup_schedule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "backup_schedule_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "backup_job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "snapshotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "backup_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "backup_job_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "backup_schedule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "restore_operation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "targetVolume" TEXT NOT NULL,
    "targetNodeId" TEXT,
    "conflict" TEXT NOT NULL DEFAULT 'overwrite',
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "bytesRestored" BIGINT,
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "restore_operation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "offsite_mirror" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "allBuckets" BOOLEAN NOT NULL DEFAULT true,
    "buckets" JSONB NOT NULL DEFAULT '[]',
    "prefix" TEXT NOT NULL DEFAULT 'swarmy-mirror',
    "everyMinutes" INTEGER NOT NULL DEFAULT 60,
    "mode" TEXT NOT NULL DEFAULT 'copy',
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sourceAccessKeyRef" TEXT,
    "sourceSecretKeyRef" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "offsite_mirror_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "offsite_mirror_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "offsite_mirror_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "mirrorId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'mirror',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "objectsCopied" INTEGER NOT NULL DEFAULT 0,
    "bytesCopied" BIGINT NOT NULL DEFAULT 0,
    "deletes" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "buckets" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "hostNodeId" TEXT,
    "actorId" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "offsite_mirror_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "offsite_mirror_run_mirrorId_fkey" FOREIGN KEY ("mirrorId") REFERENCES "offsite_mirror" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "git_repo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'GITHUB',
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "tokenEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "autodeploy" BOOLEAN NOT NULL DEFAULT false,
    "serviceId" TEXT,
    "previewsJson" JSONB,
    "connectionId" TEXT,
    "externalRepoId" TEXT,
    "fullName" TEXT,
    "configPath" TEXT NOT NULL DEFAULT 'swarmy.yaml',
    "appName" TEXT,
    "lastAppliedSha" TEXT,
    "deployKeyEnc" TEXT,
    "deployKeyPublic" TEXT,
    "requireApproval" BOOLEAN NOT NULL DEFAULT false,
    "enforceDrift" BOOLEAN NOT NULL DEFAULT false,
    "envBranches" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "git_repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "git_repo_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "git_connection" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "github_app" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "webBase" TEXT NOT NULL DEFAULT 'https://github.com',
    "appId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "ownerLogin" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT NOT NULL,
    "createdByOrgId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "git_connection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "githubAppId" TEXT,
    "installationId" TEXT,
    "account" TEXT,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" DATETIME,
    "tokenUser" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "git_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "git_connection_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "github_app" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "build" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "commit" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "image" TEXT,
    "logsRef" TEXT,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "build_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "build_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "git_repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "registry_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "credentialsEnc" TEXT,
    "requireSignedImages" BOOLEAN NOT NULL DEFAULT false,
    "blockCriticalCves" BOOLEAN NOT NULL DEFAULT false,
    "cosignPublicKey" TEXT,
    "cosignPrivateKeyEnc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "registry_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "image_gc_policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ON_HEALTHCHECK',
    "keepProd" BOOLEAN NOT NULL DEFAULT true,
    "days" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "image_gc_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "image_scan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "digest" TEXT,
    "scanner" TEXT NOT NULL DEFAULT 'trivy',
    "criticalCount" INTEGER NOT NULL DEFAULT 0,
    "highCount" INTEGER NOT NULL DEFAULT 0,
    "mediumCount" INTEGER NOT NULL DEFAULT 0,
    "lowCount" INTEGER NOT NULL DEFAULT 0,
    "reportJson" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'PASSED',
    "scannedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_scan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "registry_credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'generic',
    "label" TEXT,
    "username" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "lastTestedAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "registry_credential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "app_plan" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "planJson" JSONB,
    "desiredJson" JSONB,
    "issuesJson" JSONB,
    "ledgerJson" JSONB,
    "resultsJson" JSONB,
    "error" TEXT,
    "confirmedIds" JSONB,
    "confirmedById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "appliedAt" DATETIME,
    CONSTRAINT "app_plan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "app_plan_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "git_repo" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "node" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "sessionSecretHash" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "joinTokenId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "node_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "node_joinTokenId_fkey" FOREIGN KEY ("joinTokenId") REFERENCES "join_token" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "recovery_claim" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT,
    "hostname" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentialEnc" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "resolvedAt" DATETIME,
    CONSTRAINT "recovery_claim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "recovery_claim_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "node" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "join_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "roleHint" TEXT,
    "profile" TEXT,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "join_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "join_token_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "stack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "composeSource" TEXT NOT NULL,
    "ingressDriver" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "stack_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ts" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "audit_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "idempotency_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "vault_entry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "valueEnc" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "vault_entry_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "canvas_layout" (
    "orgId" TEXT NOT NULL PRIMARY KEY,
    "positions" JSONB NOT NULL DEFAULT '{}',
    "viewport" JSONB,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "canvas_layout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "geo_dns_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "geo_dns_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_zone" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'swarmy-ns',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ttl" INTEGER NOT NULL DEFAULT 30,
    "serial" INTEGER NOT NULL DEFAULT 1,
    "apexToEdge" BOOLEAN NOT NULL DEFAULT true,
    "autoWww" BOOLEAN NOT NULL DEFAULT true,
    "advertisedNodeIds" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dns_zone_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "dns_record" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "zoneId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "ttl" INTEGER,
    "priority" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "dns_record_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "dns_record_zoneId_fkey" FOREIGN KEY ("zoneId") REFERENCES "dns_zone" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "exposure_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL DEFAULT '{}',
    "enforce" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "exposure_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "guardrail_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "rulesJson" JSONB NOT NULL DEFAULT '{}',
    "productionSafetyMode" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "guardrail_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ingress_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'CADDY',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ingress_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "scheduled_job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stackName" TEXT,
    "schedule" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'IMAGE',
    "image" TEXT,
    "serviceRef" TEXT,
    "command" JSONB NOT NULL DEFAULT '[]',
    "envJson" JSONB NOT NULL DEFAULT '{}',
    "runOnJson" JSONB NOT NULL DEFAULT '{}',
    "timeoutMs" INTEGER NOT NULL DEFAULT 600000,
    "retries" INTEGER NOT NULL DEFAULT 0,
    "alertOnFailure" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "scheduled_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "job_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "exitCode" INTEGER,
    "outputTail" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "job_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "job_run_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "scheduled_job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_def" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stackName" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "stepsJson" JSONB NOT NULL DEFAULT '[]',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "workflow_def_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "defId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "cursor" INTEGER NOT NULL DEFAULT 0,
    "stateJson" JSONB NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "workflow_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_run_defId_fkey" FOREIGN KEY ("defId") REFERENCES "workflow_def" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "workflow_step_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "outputJson" JSONB,
    "error" TEXT,
    CONSTRAINT "workflow_step_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "workflow_step_run_runId_fkey" FOREIGN KEY ("runId") REFERENCES "workflow_run" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mesh_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'NONE',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "managementUrl" TEXT,
    "controlPlane" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mesh_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "mesh_route" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'direct',
    "targetServiceId" TEXT,
    "targetStackId" TEXT,
    "cidr" TEXT,
    "port" INTEGER,
    "proto" TEXT,
    "principalType" TEXT NOT NULL DEFAULT 'peer',
    "principalId" TEXT NOT NULL,
    "policyRef" TEXT,
    "expiresAt" DATETIME,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "mesh_route_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'SMTP',
    "configEnc" TEXT,
    "fromAddress" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "bodyText" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "notification_template_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "providerId" TEXT,
    "error" TEXT,
    "meta" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notification_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "observability_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clickhouseDsn" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "observability_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oidc_client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" JSONB,
    "userId" TEXT,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" JSONB,
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" JSONB,
    "postLogoutRedirectUris" JSONB,
    "tokenEndpointAuthMethod" TEXT,
    "grantTypes" JSONB,
    "responseTypes" JSONB,
    "public" BOOLEAN,
    "type" TEXT,
    "requirePKCE" BOOLEAN,
    "referenceId" TEXT,
    "metadata" JSONB
);

-- CreateTable
CREATE TABLE "oidc_refresh_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME,
    "revoked" DATETIME,
    "authTime" DATETIME,
    "scopes" JSONB,
    CONSTRAINT "oidc_refresh_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client" ("clientId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oidc_access_token" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "refreshId" TEXT,
    "expiresAt" DATETIME,
    "createdAt" DATETIME,
    "scopes" JSONB,
    CONSTRAINT "oidc_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client" ("clientId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "oidc_access_token_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "oidc_refresh_token" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "oidc_consent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "scopes" JSONB,
    "createdAt" DATETIME,
    "updatedAt" DATETIME,
    CONSTRAINT "oidc_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client" ("clientId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL,
    "expiresAt" DATETIME
);

-- CreateTable
CREATE TABLE "platform_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'stable',
    "feedUrl" TEXT,
    "autoApplyPatches" BOOLEAN NOT NULL DEFAULT false,
    "window" JSONB,
    "currentManifest" JSONB,
    "available" JSONB,
    "lastCheckAt" DATETIME,
    "lastCheckError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "platform_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "platform_upgrade_run" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "step" TEXT NOT NULL DEFAULT 'preflight',
    "fromVersion" TEXT NOT NULL,
    "toVersion" TEXT NOT NULL,
    "trigger" TEXT NOT NULL DEFAULT 'manual',
    "actorId" TEXT,
    "manifest" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "fromManifest" JSONB NOT NULL,
    "steps" JSONB NOT NULL,
    "options" JSONB,
    "error" TEXT,
    "log" JSONB NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "platform_upgrade_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "release" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "stackName" TEXT NOT NULL,
    "composeSource" TEXT NOT NULL,
    "imagesJson" JSONB NOT NULL DEFAULT '[]',
    "actor" TEXT,
    "strategyJson" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DEPLOYING',
    "healthGateJson" JSONB,
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "release_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "terminal_policy" (
    "orgId" TEXT NOT NULL PRIMARY KEY,
    "containerExecEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nodeShellEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requireMfa" BOOLEAN NOT NULL DEFAULT false,
    "requireApprovalForNodeShell" BOOLEAN NOT NULL DEFAULT true,
    "recordContainerExec" BOOLEAN NOT NULL DEFAULT true,
    "idleTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "maxSessionMs" INTEGER NOT NULL DEFAULT 3600000,
    "mfaMaxAgeMs" INTEGER NOT NULL DEFAULT 900000,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "terminal_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "terminal_session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "containerId" TEXT,
    "command" JSONB NOT NULL DEFAULT '{}',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "exitCode" INTEGER,
    "reason" TEXT,
    "recordingRef" TEXT,
    "bytesIn" INTEGER NOT NULL DEFAULT 0,
    "bytesOut" INTEGER NOT NULL DEFAULT 0,
    "clientIp" TEXT,
    "approvedById" TEXT,
    CONSTRAINT "terminal_session_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "terminal_approval" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "terminal_approval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inbound_endpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "stackName" TEXT,
    "domain" TEXT,
    "verifyKind" TEXT NOT NULL DEFAULT 'NONE',
    "verifySecretEnc" TEXT,
    "targetKind" TEXT NOT NULL DEFAULT 'FORWARD',
    "targetJson" JSONB NOT NULL DEFAULT '{}',
    "transformTemplate" TEXT,
    "responseTemplate" TEXT,
    "retentionDays" INTEGER NOT NULL DEFAULT 30,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "inbound_endpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "inbound_delivery" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "headersJson" JSONB NOT NULL DEFAULT '{}',
    "bodyText" TEXT NOT NULL,
    "verifyOk" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" DATETIME,
    "lastError" TEXT,
    CONSTRAINT "inbound_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "inbound_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "inbound_endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "auth_provider_config_orgId_type_key" ON "auth_provider_config"("orgId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "sso_provider_providerId_key" ON "sso_provider"("providerId");

-- CreateIndex
CREATE INDEX "sso_provider_orgId_idx" ON "sso_provider"("orgId");

-- CreateIndex
CREATE INDEX "sso_provider_domain_idx" ON "sso_provider"("domain");

-- CreateIndex
CREATE INDEX "policy_orgId_enabled_idx" ON "policy"("orgId", "enabled");

-- CreateIndex
CREATE INDEX "resource_grant_orgId_resourceType_resourceId_idx" ON "resource_grant"("orgId", "resourceType", "resourceId");

-- CreateIndex
CREATE UNIQUE INDEX "resource_grant_principalType_principalId_resourceType_resourceId_relation_key" ON "resource_grant"("principalType", "principalId", "resourceType", "resourceId", "relation");

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
CREATE INDEX "status_page_orgId_stackName_idx" ON "status_page"("orgId", "stackName");

-- CreateIndex
CREATE INDEX "uptime_sample_orgId_at_idx" ON "uptime_sample"("orgId", "at");

-- CreateIndex
CREATE INDEX "uptime_sample_pageId_componentKey_at_idx" ON "uptime_sample"("pageId", "componentKey", "at");

-- CreateIndex
CREATE UNIQUE INDEX "api_key_keyHash_key" ON "api_key"("keyHash");

-- CreateIndex
CREATE INDEX "api_key_orgId_idx" ON "api_key"("orgId");

-- CreateIndex
CREATE INDEX "api_key_prefix_idx" ON "api_key"("prefix");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_client_clientId_key" ON "oauth_client"("clientId");

-- CreateIndex
CREATE INDEX "oauth_client_orgId_idx" ON "oauth_client"("orgId");

-- CreateIndex
CREATE INDEX "webhook_endpoint_orgId_idx" ON "webhook_endpoint"("orgId");

-- CreateIndex
CREATE INDEX "webhook_delivery_orgId_idx" ON "webhook_delivery"("orgId");

-- CreateIndex
CREATE INDEX "webhook_delivery_endpointId_idx" ON "webhook_delivery"("endpointId");

-- CreateIndex
CREATE INDEX "webhook_delivery_status_nextAttemptAt_idx" ON "webhook_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

-- CreateIndex
CREATE INDEX "two_factor_userId_idx" ON "two_factor"("userId");

-- CreateIndex
CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE INDEX "member_userId_idx" ON "member"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "member_organizationId_userId_key" ON "member"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "backup_target_orgId_idx" ON "backup_target"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "backup_target_orgId_name_key" ON "backup_target"("orgId", "name");

-- CreateIndex
CREATE INDEX "snapshot_orgId_startedAt_idx" ON "snapshot"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "snapshot_volume_startedAt_idx" ON "snapshot"("volume", "startedAt");

-- CreateIndex
CREATE INDEX "snapshot_targetId_idx" ON "snapshot"("targetId");

-- CreateIndex
CREATE INDEX "controller_snapshot_startedAt_idx" ON "controller_snapshot"("startedAt");

-- CreateIndex
CREATE INDEX "controller_snapshot_targetId_idx" ON "controller_snapshot"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_cluster_orgId_key" ON "storage_cluster"("orgId");

-- CreateIndex
CREATE INDEX "bucket_access_orgId_idx" ON "bucket_access"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "bucket_access_orgId_bucketId_key" ON "bucket_access"("orgId", "bucketId");

-- CreateIndex
CREATE INDEX "backup_schedule_orgId_idx" ON "backup_schedule"("orgId");

-- CreateIndex
CREATE INDEX "backup_schedule_orgId_volume_idx" ON "backup_schedule"("orgId", "volume");

-- CreateIndex
CREATE INDEX "backup_schedule_paused_idx" ON "backup_schedule"("paused");

-- CreateIndex
CREATE INDEX "backup_job_orgId_idx" ON "backup_job"("orgId");

-- CreateIndex
CREATE INDEX "backup_job_scheduleId_startedAt_idx" ON "backup_job"("scheduleId", "startedAt");

-- CreateIndex
CREATE INDEX "restore_operation_orgId_startedAt_idx" ON "restore_operation"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "restore_operation_orgId_snapshotId_status_idx" ON "restore_operation"("orgId", "snapshotId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "offsite_mirror_orgId_key" ON "offsite_mirror"("orgId");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_orgId_startedAt_idx" ON "offsite_mirror_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_mirrorId_startedAt_idx" ON "offsite_mirror_run"("mirrorId", "startedAt");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_status_idx" ON "offsite_mirror_run"("status");

-- CreateIndex
CREATE INDEX "git_repo_orgId_idx" ON "git_repo"("orgId");

-- CreateIndex
CREATE INDEX "git_repo_connectionId_idx" ON "git_repo"("connectionId");

-- CreateIndex
CREATE INDEX "git_repo_externalRepoId_idx" ON "git_repo"("externalRepoId");

-- CreateIndex
CREATE UNIQUE INDEX "git_repo_orgId_url_branch_configPath_key" ON "git_repo"("orgId", "url", "branch", "configPath");

-- CreateIndex
CREATE UNIQUE INDEX "github_app_webBase_appId_key" ON "github_app"("webBase", "appId");

-- CreateIndex
CREATE INDEX "git_connection_orgId_idx" ON "git_connection"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "git_connection_githubAppId_installationId_key" ON "git_connection"("githubAppId", "installationId");

-- CreateIndex
CREATE INDEX "build_orgId_startedAt_idx" ON "build"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "build_repoId_startedAt_idx" ON "build"("repoId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "registry_config_orgId_key" ON "registry_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "image_gc_policy_orgId_key" ON "image_gc_policy"("orgId");

-- CreateIndex
CREATE INDEX "image_scan_orgId_scannedAt_idx" ON "image_scan"("orgId", "scannedAt");

-- CreateIndex
CREATE INDEX "image_scan_orgId_imageRef_idx" ON "image_scan"("orgId", "imageRef");

-- CreateIndex
CREATE INDEX "image_scan_digest_idx" ON "image_scan"("digest");

-- CreateIndex
CREATE INDEX "registry_credential_orgId_idx" ON "registry_credential"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "registry_credential_orgId_prefix_key" ON "registry_credential"("orgId", "prefix");

-- CreateIndex
CREATE INDEX "app_plan_orgId_createdAt_idx" ON "app_plan"("orgId", "createdAt");

-- CreateIndex
CREATE INDEX "app_plan_repoId_environment_createdAt_idx" ON "app_plan"("repoId", "environment", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "app_plan_repoId_environment_sha_trigger_prNumber_key" ON "app_plan"("repoId", "environment", "sha", "trigger", "prNumber");

-- CreateIndex
CREATE UNIQUE INDEX "node_orgId_name_key" ON "node"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "recovery_claim_claimHash_key" ON "recovery_claim"("claimHash");

-- CreateIndex
CREATE INDEX "recovery_claim_orgId_status_idx" ON "recovery_claim"("orgId", "status");

-- CreateIndex
CREATE INDEX "recovery_claim_hostname_idx" ON "recovery_claim"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "join_token_tokenHash_key" ON "join_token"("tokenHash");

-- CreateIndex
CREATE INDEX "join_token_orgId_idx" ON "join_token"("orgId");

-- CreateIndex
CREATE INDEX "join_token_tokenPrefix_idx" ON "join_token"("tokenPrefix");

-- CreateIndex
CREATE INDEX "stack_orgId_idx" ON "stack"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "stack_orgId_name_key" ON "stack"("orgId", "name");

-- CreateIndex
CREATE INDEX "audit_log_orgId_ts_idx" ON "audit_log"("orgId", "ts");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_idx" ON "audit_log"("targetType", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_orgId_key_key" ON "idempotency_key"("orgId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "vault_entry_orgId_name_key" ON "vault_entry"("orgId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "geo_dns_config_orgId_key" ON "geo_dns_config"("orgId");

-- CreateIndex
CREATE INDEX "dns_zone_orgId_idx" ON "dns_zone"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "dns_zone_orgId_zone_key" ON "dns_zone"("orgId", "zone");

-- CreateIndex
CREATE INDEX "dns_record_orgId_idx" ON "dns_record"("orgId");

-- CreateIndex
CREATE INDEX "dns_record_zoneId_idx" ON "dns_record"("zoneId");

-- CreateIndex
CREATE UNIQUE INDEX "dns_record_orgId_zoneId_name_type_value_key" ON "dns_record"("orgId", "zoneId", "name", "type", "value");

-- CreateIndex
CREATE UNIQUE INDEX "exposure_config_orgId_key" ON "exposure_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "guardrail_config_orgId_key" ON "guardrail_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_config_orgId_key" ON "ingress_config"("orgId");

-- CreateIndex
CREATE INDEX "scheduled_job_orgId_idx" ON "scheduled_job"("orgId");

-- CreateIndex
CREATE INDEX "scheduled_job_orgId_stackName_idx" ON "scheduled_job"("orgId", "stackName");

-- CreateIndex
CREATE INDEX "scheduled_job_enabled_idx" ON "scheduled_job"("enabled");

-- CreateIndex
CREATE UNIQUE INDEX "scheduled_job_orgId_name_key" ON "scheduled_job"("orgId", "name");

-- CreateIndex
CREATE INDEX "job_run_orgId_startedAt_idx" ON "job_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "job_run_jobId_startedAt_idx" ON "job_run"("jobId", "startedAt");

-- CreateIndex
CREATE INDEX "workflow_def_orgId_idx" ON "workflow_def"("orgId");

-- CreateIndex
CREATE INDEX "workflow_def_orgId_stackName_idx" ON "workflow_def"("orgId", "stackName");

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
CREATE UNIQUE INDEX "mesh_config_orgId_key" ON "mesh_config"("orgId");

-- CreateIndex
CREATE INDEX "mesh_route_orgId_idx" ON "mesh_route"("orgId");

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
CREATE UNIQUE INDEX "observability_config_orgId_key" ON "observability_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_client_clientId_key" ON "oidc_client"("clientId");

-- CreateIndex
CREATE INDEX "oidc_client_userId_idx" ON "oidc_client"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_refresh_token_token_key" ON "oidc_refresh_token"("token");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_clientId_idx" ON "oidc_refresh_token"("clientId");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_sessionId_idx" ON "oidc_refresh_token"("sessionId");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_userId_idx" ON "oidc_refresh_token"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_access_token_token_key" ON "oidc_access_token"("token");

-- CreateIndex
CREATE INDEX "oidc_access_token_clientId_idx" ON "oidc_access_token"("clientId");

-- CreateIndex
CREATE INDEX "oidc_access_token_sessionId_idx" ON "oidc_access_token"("sessionId");

-- CreateIndex
CREATE INDEX "oidc_access_token_userId_idx" ON "oidc_access_token"("userId");

-- CreateIndex
CREATE INDEX "oidc_access_token_refreshId_idx" ON "oidc_access_token"("refreshId");

-- CreateIndex
CREATE INDEX "oidc_consent_clientId_idx" ON "oidc_consent"("clientId");

-- CreateIndex
CREATE INDEX "oidc_consent_userId_idx" ON "oidc_consent"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "platform_config_orgId_key" ON "platform_config"("orgId");

-- CreateIndex
CREATE INDEX "platform_upgrade_run_orgId_startedAt_idx" ON "platform_upgrade_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "release_orgId_stackName_createdAt_idx" ON "release"("orgId", "stackName", "createdAt");

-- CreateIndex
CREATE INDEX "release_orgId_status_idx" ON "release"("orgId", "status");

-- CreateIndex
CREATE INDEX "terminal_session_orgId_startedAt_idx" ON "terminal_session"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "terminal_session_actorId_idx" ON "terminal_session"("actorId");

-- CreateIndex
CREATE INDEX "terminal_approval_orgId_status_idx" ON "terminal_approval"("orgId", "status");

-- CreateIndex
CREATE INDEX "terminal_approval_requestedById_nodeId_idx" ON "terminal_approval"("requestedById", "nodeId");

-- CreateIndex
CREATE INDEX "inbound_endpoint_orgId_idx" ON "inbound_endpoint"("orgId");

-- CreateIndex
CREATE INDEX "inbound_endpoint_orgId_stackName_idx" ON "inbound_endpoint"("orgId", "stackName");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_endpoint_orgId_slug_key" ON "inbound_endpoint"("orgId", "slug");

-- CreateIndex
CREATE INDEX "inbound_delivery_orgId_receivedAt_idx" ON "inbound_delivery"("orgId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_delivery_endpointId_receivedAt_idx" ON "inbound_delivery"("endpointId", "receivedAt");

-- CreateIndex
CREATE INDEX "inbound_delivery_status_nextAttemptAt_idx" ON "inbound_delivery"("status", "nextAttemptAt");
