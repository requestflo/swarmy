-- Per-bucket S3 reachability (INTERNAL | MESH | PUBLIC), enforced at the edge,
-- plus the org's public S3 hostname.
-- AlterTable
ALTER TABLE "storage_cluster" ADD COLUMN "publicS3Domain" TEXT;

-- CreateTable
CREATE TABLE "bucket_access" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "bucketName" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'INTERNAL',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "bucket_access_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bucket_access_orgId_bucketId_key" ON "bucket_access"("orgId", "bucketId");

-- CreateIndex
CREATE INDEX "bucket_access_orgId_idx" ON "bucket_access"("orgId");
