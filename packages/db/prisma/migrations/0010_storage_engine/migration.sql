-- Object-storage engine tracking: the Garage image each store runs (null =
-- legacy v1.0.1) and the resumable state of an engine upgrade run.
-- AlterTable
ALTER TABLE "storage_cluster" ADD COLUMN "engineImage" TEXT;
ALTER TABLE "storage_cluster" ADD COLUMN "engineUpgrade" JSONB;
