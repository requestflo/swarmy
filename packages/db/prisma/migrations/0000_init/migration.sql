-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "NodeRole" AS ENUM ('MANAGER', 'WORKER');

-- CreateEnum
CREATE TYPE "IngressDriver" AS ENUM ('CADDY', 'TRAEFIK', 'NONE', 'CLOUDFLARE_TUNNEL', 'NGINX', 'HAPROXY');

-- CreateEnum
CREATE TYPE "BackupTargetKind" AS ENUM ('S3', 'NODE');

-- CreateEnum
CREATE TYPE "SnapshotStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED', 'PRUNED');

-- CreateEnum
CREATE TYPE "MetricScope" AS ENUM ('NODE', 'CONTAINER');

-- CreateEnum
CREATE TYPE "MeshDriver" AS ENUM ('NETBIRD', 'HEADSCALE', 'TAILSCALE', 'WIREGUARD', 'NONE');

-- CreateEnum
CREATE TYPE "GitProviderKind" AS ENUM ('GITHUB', 'GITLAB');

-- CreateEnum
CREATE TYPE "BuildStatus" AS ENUM ('QUEUED', 'BUILDING', 'PUSHING', 'SUCCEEDED', 'FAILED', 'CANCELED');

-- CreateEnum
CREATE TYPE "ImageGcMode" AS ENUM ('ON_HEALTHCHECK', 'AGE_DAYS');

-- CreateEnum
CREATE TYPE "StorageClusterDriver" AS ENUM ('GARAGE', 'MINIO', 'NONE');

-- CreateEnum
CREATE TYPE "ClusterVolumeStatus" AS ENUM ('PROVISIONING', 'READY', 'FAILED');

-- CreateEnum
CREATE TYPE "BackupJobStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "RestoreStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "activeOrganizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "logo" TEXT,
    "metadata" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "attributes" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "node" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "sessionSecretHash" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "joinTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "node_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "join_token" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenPrefix" TEXT NOT NULL,
    "label" TEXT,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "roleHint" "NodeRole",
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "join_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stack" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "composeSource" TEXT NOT NULL,
    "telemetryEnabled" BOOLEAN NOT NULL DEFAULT false,
    "ingressDriver" "IngressDriver",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "metric_sample" (
    "id" BIGSERIAL NOT NULL,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "scope" "MetricScope" NOT NULL,
    "containerId" TEXT,
    "serviceId" TEXT,
    "cpuPercent" DOUBLE PRECISION NOT NULL,
    "memUsedBytes" BIGINT NOT NULL,
    "memTotalBytes" BIGINT NOT NULL,
    "netRxBytes" BIGINT NOT NULL,
    "netTxBytes" BIGINT NOT NULL,
    "diskUsedBytes" BIGINT NOT NULL,
    "diskTotalBytes" BIGINT NOT NULL,
    "ts" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "metric_sample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ingress_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "driver" "IngressDriver" NOT NULL DEFAULT 'NONE',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ingress_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorType" TEXT NOT NULL DEFAULT 'user',
    "action" TEXT NOT NULL,
    "targetType" TEXT,
    "targetId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ts" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_target" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "kind" "BackupTargetKind" NOT NULL DEFAULT 'S3',
    "endpoint" TEXT,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT,
    "region" TEXT,
    "credentialRef" TEXT,
    "secretKeyRef" TEXT,
    "resticPasswordRef" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "snapshot" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "resticId" TEXT,
    "sizeBytes" BIGINT,
    "error" TEXT,
    "hostNodeId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observability_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clickhouseDsn" TEXT,
    "collectorStatus" TEXT NOT NULL DEFAULT 'OFFLINE',
    "retentionDays" INTEGER NOT NULL DEFAULT 7,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "observability_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "observability_store_state" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNKNOWN',
    "reachable" BOOLEAN NOT NULL DEFAULT false,
    "diskUsedBytes" BIGINT NOT NULL DEFAULT 0,
    "lastCheckedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "observability_store_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesh_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "driver" "MeshDriver" NOT NULL DEFAULT 'NONE',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "managementUrl" TEXT,
    "controlPlane" JSONB NOT NULL DEFAULT '{}',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mesh_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesh_peer" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "driver" TEXT NOT NULL DEFAULT 'NONE',
    "peerId" TEXT,
    "meshIp" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ENROLLING',
    "lastSeen" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mesh_peer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_provider_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT,
    "type" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "clientId" TEXT,
    "encryptedSecret" TEXT,
    "scopes" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "auth_provider_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sso_provider" (
    "id" TEXT NOT NULL,
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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sso_provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "policy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "effect" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "isdefault" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resource_grant" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "principalType" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_repo" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" "GitProviderKind" NOT NULL DEFAULT 'GITHUB',
    "url" TEXT NOT NULL,
    "branch" TEXT NOT NULL DEFAULT 'main',
    "tokenEnc" TEXT,
    "webhookSecretEnc" TEXT,
    "autodeploy" BOOLEAN NOT NULL DEFAULT false,
    "serviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_repo_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "build" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "commit" TEXT,
    "status" "BuildStatus" NOT NULL DEFAULT 'QUEUED',
    "image" TEXT,
    "logsRef" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "build_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "registry_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "host" TEXT,
    "credentialsEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_gc_policy" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "mode" "ImageGcMode" NOT NULL DEFAULT 'ON_HEALTHCHECK',
    "keepProd" BOOLEAN NOT NULL DEFAULT true,
    "days" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "image_gc_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "geo_dns_config" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "zone" TEXT NOT NULL DEFAULT '',
    "ttl" INTEGER NOT NULL DEFAULT 30,
    "provider" TEXT NOT NULL DEFAULT 'coredns',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "geo_dns_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dns_record" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "targetIngress" TEXT NOT NULL,
    "healthy" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dns_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_key" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["read"]',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_client" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL DEFAULT '["read"]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "oauth_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_endpoint" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" JSONB NOT NULL DEFAULT '[]',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_endpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "webhook_delivery" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),

    CONSTRAINT "webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controller_backup_config" (
    "id" TEXT NOT NULL DEFAULT 'controller',
    "targetId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "schedule" TEXT NOT NULL DEFAULT '0 3 * * *',
    "retention" JSONB NOT NULL DEFAULT '{"keepDaily":7,"keepWeekly":4,"keepMonthly":3}',
    "restorePassphraseRef" TEXT,
    "restorePassphraseHint" TEXT,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "controller_backup_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "controller_snapshot" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "resticSnapshotId" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "manifestJson" JSONB,
    "status" "SnapshotStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "controller_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "storage_cluster" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "driver" "StorageClusterDriver" NOT NULL DEFAULT 'NONE',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "replicationFactor" INTEGER NOT NULL DEFAULT 3,
    "region" TEXT NOT NULL DEFAULT 'swarmy',
    "memberNodeIds" JSONB NOT NULL DEFAULT '[]',
    "layout" JSONB NOT NULL DEFAULT '{}',
    "rpcSecretRef" TEXT,
    "adminTokenRef" TEXT,
    "accessKeyRef" TEXT,
    "secretKeyRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "storage_cluster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cluster_volume" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "csiDriver" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL DEFAULT 'single-writer',
    "capacityBytes" BIGINT,
    "options" JSONB NOT NULL DEFAULT '{}',
    "status" "ClusterVolumeStatus" NOT NULL DEFAULT 'PROVISIONING',
    "serviceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cluster_volume_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_schedule" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "volume" TEXT NOT NULL,
    "nodeId" TEXT,
    "every" INTEGER NOT NULL,
    "unit" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "backup_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "backup_job" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "snapshotId" TEXT,
    "status" "BackupJobStatus" NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "backup_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restore_operation" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "targetVolume" TEXT NOT NULL,
    "targetNodeId" TEXT,
    "conflict" TEXT NOT NULL DEFAULT 'overwrite',
    "status" "RestoreStatus" NOT NULL DEFAULT 'QUEUED',
    "reason" TEXT NOT NULL DEFAULT 'manual',
    "bytesRestored" BIGINT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "restore_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesh_route" (
    "id" TEXT NOT NULL,
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
    "expiresAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "mesh_route_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mesh_acl" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "routeId" TEXT NOT NULL,
    "driver" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "rendered" JSONB NOT NULL DEFAULT '{}',
    "appliedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mesh_acl_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tunnel" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'cloudflare',
    "externalId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentialRef" TEXT,
    "tunnelTokenRef" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tunnel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_policy" (
    "orgId" TEXT NOT NULL,
    "containerExecEnabled" BOOLEAN NOT NULL DEFAULT true,
    "nodeShellEnabled" BOOLEAN NOT NULL DEFAULT false,
    "requireMfa" BOOLEAN NOT NULL DEFAULT true,
    "requireApprovalForNodeShell" BOOLEAN NOT NULL DEFAULT true,
    "recordContainerExec" BOOLEAN NOT NULL DEFAULT true,
    "idleTimeoutMs" INTEGER NOT NULL DEFAULT 300000,
    "maxSessionMs" INTEGER NOT NULL DEFAULT 3600000,
    "allowedRoles" JSONB NOT NULL DEFAULT '["owner","admin"]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "terminal_policy_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "terminal_session" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "containerId" TEXT,
    "command" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" TIMESTAMP(3),
    "exitCode" INTEGER,
    "reason" TEXT,
    "recordingRef" TEXT,
    "bytesIn" INTEGER NOT NULL DEFAULT 0,
    "bytesOut" INTEGER NOT NULL DEFAULT 0,
    "clientIp" TEXT,
    "approvedById" TEXT,

    CONSTRAINT "terminal_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "terminal_approval" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "terminal_approval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "swarm_config" (
    "orgId" TEXT NOT NULL,
    "swarmId" TEXT,
    "managerNodeId" TEXT,
    "managerAddr" TEXT,
    "workerJoinTokenEnc" TEXT,
    "managerJoinTokenEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "swarm_config_pkey" PRIMARY KEY ("orgId")
);

-- CreateTable
CREATE TABLE "canvas_layout" (
    "orgId" TEXT NOT NULL,
    "positions" JSONB NOT NULL DEFAULT '{}',
    "viewport" JSONB,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "canvas_layout_pkey" PRIMARY KEY ("orgId")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "account_providerId_accountId_key" ON "account"("providerId", "accountId");

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
CREATE UNIQUE INDEX "node_orgId_name_key" ON "node"("orgId", "name");

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
CREATE INDEX "metric_sample_nodeId_ts_idx" ON "metric_sample"("nodeId", "ts");

-- CreateIndex
CREATE INDEX "metric_sample_scope_containerId_ts_idx" ON "metric_sample"("scope", "containerId", "ts");

-- CreateIndex
CREATE INDEX "metric_sample_orgId_ts_idx" ON "metric_sample"("orgId", "ts");

-- CreateIndex
CREATE UNIQUE INDEX "ingress_config_orgId_key" ON "ingress_config"("orgId");

-- CreateIndex
CREATE INDEX "audit_log_orgId_ts_idx" ON "audit_log"("orgId", "ts");

-- CreateIndex
CREATE INDEX "audit_log_targetType_targetId_idx" ON "audit_log"("targetType", "targetId");

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
CREATE UNIQUE INDEX "observability_config_orgId_key" ON "observability_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "observability_store_state_orgId_key" ON "observability_store_state"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "mesh_config_orgId_key" ON "mesh_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "mesh_peer_nodeId_key" ON "mesh_peer"("nodeId");

-- CreateIndex
CREATE INDEX "mesh_peer_orgId_idx" ON "mesh_peer"("orgId");

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
CREATE UNIQUE INDEX "resource_grant_principalType_principalId_resourceType_resou_key" ON "resource_grant"("principalType", "principalId", "resourceType", "resourceId", "relation");

-- CreateIndex
CREATE INDEX "git_repo_orgId_idx" ON "git_repo"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "git_repo_orgId_url_key" ON "git_repo"("orgId", "url");

-- CreateIndex
CREATE INDEX "build_orgId_startedAt_idx" ON "build"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "build_repoId_startedAt_idx" ON "build"("repoId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "registry_config_orgId_key" ON "registry_config"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "image_gc_policy_orgId_key" ON "image_gc_policy"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "geo_dns_config_orgId_key" ON "geo_dns_config"("orgId");

-- CreateIndex
CREATE INDEX "dns_record_orgId_idx" ON "dns_record"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "dns_record_orgId_host_region_key" ON "dns_record"("orgId", "host", "region");

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
CREATE INDEX "controller_snapshot_startedAt_idx" ON "controller_snapshot"("startedAt");

-- CreateIndex
CREATE INDEX "controller_snapshot_targetId_idx" ON "controller_snapshot"("targetId");

-- CreateIndex
CREATE UNIQUE INDEX "storage_cluster_orgId_key" ON "storage_cluster"("orgId");

-- CreateIndex
CREATE INDEX "cluster_volume_orgId_idx" ON "cluster_volume"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "cluster_volume_orgId_name_key" ON "cluster_volume"("orgId", "name");

-- CreateIndex
CREATE INDEX "backup_schedule_orgId_idx" ON "backup_schedule"("orgId");

-- CreateIndex
CREATE INDEX "backup_schedule_paused_nextRunAt_idx" ON "backup_schedule"("paused", "nextRunAt");

-- CreateIndex
CREATE INDEX "backup_job_orgId_idx" ON "backup_job"("orgId");

-- CreateIndex
CREATE INDEX "restore_operation_orgId_startedAt_idx" ON "restore_operation"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "restore_operation_orgId_snapshotId_status_idx" ON "restore_operation"("orgId", "snapshotId", "status");

-- CreateIndex
CREATE INDEX "mesh_route_orgId_idx" ON "mesh_route"("orgId");

-- CreateIndex
CREATE INDEX "mesh_acl_orgId_idx" ON "mesh_acl"("orgId");

-- CreateIndex
CREATE INDEX "mesh_acl_routeId_idx" ON "mesh_acl"("routeId");

-- CreateIndex
CREATE INDEX "tunnel_orgId_idx" ON "tunnel"("orgId");

-- CreateIndex
CREATE INDEX "terminal_session_orgId_startedAt_idx" ON "terminal_session"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "terminal_session_actorId_idx" ON "terminal_session"("actorId");

-- CreateIndex
CREATE INDEX "terminal_approval_orgId_status_idx" ON "terminal_approval"("orgId", "status");

-- CreateIndex
CREATE INDEX "terminal_approval_requestedById_nodeId_idx" ON "terminal_approval"("requestedById", "nodeId");

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_key_orgId_key_key" ON "idempotency_key"("orgId", "key");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node" ADD CONSTRAINT "node_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "node" ADD CONSTRAINT "node_joinTokenId_fkey" FOREIGN KEY ("joinTokenId") REFERENCES "join_token"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_token" ADD CONSTRAINT "join_token_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "join_token" ADD CONSTRAINT "join_token_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stack" ADD CONSTRAINT "stack_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "metric_sample" ADD CONSTRAINT "metric_sample_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "node"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ingress_config" ADD CONSTRAINT "ingress_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_target" ADD CONSTRAINT "backup_target_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "snapshot" ADD CONSTRAINT "snapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observability_config" ADD CONSTRAINT "observability_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "observability_store_state" ADD CONSTRAINT "observability_store_state_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesh_config" ADD CONSTRAINT "mesh_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesh_peer" ADD CONSTRAINT "mesh_peer_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sso_provider" ADD CONSTRAINT "sso_provider_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "policy" ADD CONSTRAINT "policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_grant" ADD CONSTRAINT "resource_grant_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_repo" ADD CONSTRAINT "git_repo_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "build" ADD CONSTRAINT "build_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "git_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "registry_config" ADD CONSTRAINT "registry_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "image_gc_policy" ADD CONSTRAINT "image_gc_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "geo_dns_config" ADD CONSTRAINT "geo_dns_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dns_record" ADD CONSTRAINT "dns_record_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_key" ADD CONSTRAINT "api_key_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_client" ADD CONSTRAINT "oauth_client_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_endpoint" ADD CONSTRAINT "webhook_endpoint_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "webhook_endpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "controller_backup_config" ADD CONSTRAINT "controller_backup_config_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "controller_snapshot" ADD CONSTRAINT "controller_snapshot_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "storage_cluster" ADD CONSTRAINT "storage_cluster_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cluster_volume" ADD CONSTRAINT "cluster_volume_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_schedule" ADD CONSTRAINT "backup_schedule_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_job" ADD CONSTRAINT "backup_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "backup_job" ADD CONSTRAINT "backup_job_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "backup_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "restore_operation" ADD CONSTRAINT "restore_operation_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesh_route" ADD CONSTRAINT "mesh_route_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesh_acl" ADD CONSTRAINT "mesh_acl_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mesh_acl" ADD CONSTRAINT "mesh_acl_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "mesh_route"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tunnel" ADD CONSTRAINT "tunnel_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_policy" ADD CONSTRAINT "terminal_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_session" ADD CONSTRAINT "terminal_session_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "terminal_approval" ADD CONSTRAINT "terminal_approval_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "swarm_config" ADD CONSTRAINT "swarm_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "canvas_layout" ADD CONSTRAINT "canvas_layout_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

