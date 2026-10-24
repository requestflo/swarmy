-- CreateTable
CREATE TABLE "cache_stat_sample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "bucketStart" DATETIME NOT NULL,
    "hits" BIGINT NOT NULL,
    "misses" BIGINT NOT NULL,
    "opsPerSec" INTEGER NOT NULL,
    "usedMemoryBytes" BIGINT NOT NULL
);

-- CreateTable
CREATE TABLE "queue_stat_sample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "queue" TEXT NOT NULL,
    "bucketStart" DATETIME NOT NULL,
    "waiting" INTEGER NOT NULL,
    "active" INTEGER NOT NULL,
    "completed" INTEGER,
    "failed" INTEGER,
    "workers" INTEGER
);

-- CreateTable
CREATE TABLE "bucket_stat_sample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "bucketId" TEXT NOT NULL,
    "bucketStart" DATETIME NOT NULL,
    "bytes" BIGINT NOT NULL,
    "objects" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "cache_stat_sample_bucketStart_idx" ON "cache_stat_sample"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "cache_stat_sample_orgId_stack_cluster_bucketStart_key" ON "cache_stat_sample"("orgId", "stack", "cluster", "bucketStart");

-- CreateIndex
CREATE INDEX "queue_stat_sample_bucketStart_idx" ON "queue_stat_sample"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "queue_stat_sample_orgId_stack_cluster_prefix_queue_bucketStart_key" ON "queue_stat_sample"("orgId", "stack", "cluster", "prefix", "queue", "bucketStart");

-- CreateIndex
CREATE INDEX "bucket_stat_sample_bucketStart_idx" ON "bucket_stat_sample"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "bucket_stat_sample_orgId_bucketId_bucketStart_key" ON "bucket_stat_sample"("orgId", "bucketId", "bucketStart");
