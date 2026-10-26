-- AlterTable
ALTER TABLE "release" ADD COLUMN "healthyAt" DATETIME;
ALTER TABLE "release" ADD COLUMN "rollbackOf" TEXT;
ALTER TABLE "release" ADD COLUMN "startedAt" DATETIME;
