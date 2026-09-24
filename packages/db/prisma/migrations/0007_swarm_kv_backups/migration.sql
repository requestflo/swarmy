-- DropIndex
DROP INDEX "backup_schedule_paused_idx";

-- DropIndex
DROP INDEX "backup_schedule_orgId_volume_idx";

-- DropIndex
DROP INDEX "backup_schedule_orgId_idx";

-- DropIndex
DROP INDEX "backup_target_orgId_name_key";

-- DropIndex
DROP INDEX "backup_target_orgId_idx";

-- DropIndex
DROP INDEX "offsite_mirror_orgId_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "backup_schedule";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "backup_target";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "controller_backup_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "offsite_mirror";
PRAGMA foreign_keys=on;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_backup_job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "scheduleId" TEXT,
    "snapshotId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "error" TEXT,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "backup_job_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_backup_job" ("error", "finishedAt", "id", "orgId", "scheduleId", "snapshotId", "startedAt", "status") SELECT "error", "finishedAt", "id", "orgId", "scheduleId", "snapshotId", "startedAt", "status" FROM "backup_job";
DROP TABLE "backup_job";
ALTER TABLE "new_backup_job" RENAME TO "backup_job";
CREATE INDEX "backup_job_orgId_idx" ON "backup_job"("orgId");
CREATE INDEX "backup_job_scheduleId_startedAt_idx" ON "backup_job"("scheduleId", "startedAt");
CREATE TABLE "new_controller_snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "targetId" TEXT NOT NULL,
    "resticSnapshotId" TEXT,
    "sizeBytes" BIGINT,
    "durationMs" INTEGER,
    "manifestJson" JSONB,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "error" TEXT
);
INSERT INTO "new_controller_snapshot" ("durationMs", "error", "finishedAt", "id", "manifestJson", "resticSnapshotId", "sizeBytes", "startedAt", "status", "targetId") SELECT "durationMs", "error", "finishedAt", "id", "manifestJson", "resticSnapshotId", "sizeBytes", "startedAt", "status", "targetId" FROM "controller_snapshot";
DROP TABLE "controller_snapshot";
ALTER TABLE "new_controller_snapshot" RENAME TO "controller_snapshot";
CREATE INDEX "controller_snapshot_startedAt_idx" ON "controller_snapshot"("startedAt");
CREATE INDEX "controller_snapshot_targetId_idx" ON "controller_snapshot"("targetId");
CREATE TABLE "new_offsite_mirror_run" (
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
    CONSTRAINT "offsite_mirror_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_offsite_mirror_run" ("actorId", "buckets", "bytesCopied", "deletes", "direction", "error", "errorCount", "finishedAt", "hostNodeId", "id", "mirrorId", "objectsCopied", "orgId", "startedAt", "status", "trigger") SELECT "actorId", "buckets", "bytesCopied", "deletes", "direction", "error", "errorCount", "finishedAt", "hostNodeId", "id", "mirrorId", "objectsCopied", "orgId", "startedAt", "status", "trigger" FROM "offsite_mirror_run";
DROP TABLE "offsite_mirror_run";
ALTER TABLE "new_offsite_mirror_run" RENAME TO "offsite_mirror_run";
CREATE INDEX "offsite_mirror_run_orgId_startedAt_idx" ON "offsite_mirror_run"("orgId", "startedAt");
CREATE INDEX "offsite_mirror_run_mirrorId_startedAt_idx" ON "offsite_mirror_run"("mirrorId", "startedAt");
CREATE INDEX "offsite_mirror_run_status_idx" ON "offsite_mirror_run"("status");
CREATE TABLE "new_snapshot" (
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
    CONSTRAINT "snapshot_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_snapshot" ("error", "finishedAt", "hostNodeId", "id", "orgId", "resticId", "sizeBytes", "startedAt", "status", "targetId", "volume") SELECT "error", "finishedAt", "hostNodeId", "id", "orgId", "resticId", "sizeBytes", "startedAt", "status", "targetId", "volume" FROM "snapshot";
DROP TABLE "snapshot";
ALTER TABLE "new_snapshot" RENAME TO "snapshot";
CREATE INDEX "snapshot_orgId_startedAt_idx" ON "snapshot"("orgId", "startedAt");
CREATE INDEX "snapshot_volume_startedAt_idx" ON "snapshot"("volume", "startedAt");
CREATE INDEX "snapshot_targetId_idx" ON "snapshot"("targetId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
