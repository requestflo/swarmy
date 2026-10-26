-- AlterTable
ALTER TABLE "incident" ADD COLUMN "ownedUntil" DATETIME;
ALTER TABLE "incident" ADD COLUMN "ownerName" TEXT;
ALTER TABLE "incident" ADD COLUMN "ownerUserId" TEXT;
