-- Off-site mirror: one config per org (Garage buckets to an S3 backup target)
-- plus the per-run history (mirror and restore directions).
-- CreateTable
CREATE TABLE "offsite_mirror" (
    "id" TEXT NOT NULL,
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
    "grantedBucketIds" JSONB NOT NULL DEFAULT '[]',
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "offsite_mirror_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "offsite_mirror_run" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "mirrorId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'mirror',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "status" "BackupJobStatus" NOT NULL DEFAULT 'RUNNING',
    "objectsCopied" INTEGER NOT NULL DEFAULT 0,
    "bytesCopied" BIGINT NOT NULL DEFAULT 0,
    "deletes" INTEGER NOT NULL DEFAULT 0,
    "errorCount" INTEGER NOT NULL DEFAULT 0,
    "buckets" JSONB NOT NULL DEFAULT '[]',
    "error" TEXT,
    "hostNodeId" TEXT,
    "actorId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "offsite_mirror_run_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "offsite_mirror_orgId_key" ON "offsite_mirror"("orgId");

-- CreateIndex
CREATE INDEX "offsite_mirror_enabled_nextRunAt_idx" ON "offsite_mirror"("enabled", "nextRunAt");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_orgId_startedAt_idx" ON "offsite_mirror_run"("orgId", "startedAt");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_mirrorId_startedAt_idx" ON "offsite_mirror_run"("mirrorId", "startedAt");

-- CreateIndex
CREATE INDEX "offsite_mirror_run_status_idx" ON "offsite_mirror_run"("status");

-- AddForeignKey
ALTER TABLE "offsite_mirror" ADD CONSTRAINT "offsite_mirror_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offsite_mirror" ADD CONSTRAINT "offsite_mirror_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "backup_target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offsite_mirror_run" ADD CONSTRAINT "offsite_mirror_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "offsite_mirror_run" ADD CONSTRAINT "offsite_mirror_run_mirrorId_fkey" FOREIGN KEY ("mirrorId") REFERENCES "offsite_mirror"("id") ON DELETE CASCADE ON UPDATE CASCADE;

