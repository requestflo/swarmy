-- Default-on DB backups: auto-created volume schedules, their retention +
-- staggered anchor, and the opt-out tombstone a user leaves by removing one.
-- AlterTable
ALTER TABLE "backup_schedule" ADD COLUMN IF NOT EXISTS "auto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "backup_schedule" ADD COLUMN IF NOT EXISTS "retentionDays" INTEGER;
ALTER TABLE "backup_schedule" ADD COLUMN IF NOT EXISTS "anchorAt" TIMESTAMP(3);
ALTER TABLE "backup_schedule" ADD COLUMN IF NOT EXISTS "optedOutAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "backup_schedule_orgId_volume_idx" ON "backup_schedule"("orgId", "volume");
