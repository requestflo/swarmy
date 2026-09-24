-- CreateTable
CREATE TABLE "metric_sample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "containerId" TEXT,
    "serviceId" TEXT,
    "cpuPercent" REAL NOT NULL,
    "memUsedBytes" BIGINT NOT NULL,
    "memTotalBytes" BIGINT NOT NULL,
    "netRxBytes" BIGINT NOT NULL,
    "netTxBytes" BIGINT NOT NULL,
    "diskUsedBytes" BIGINT NOT NULL,
    "diskTotalBytes" BIGINT NOT NULL,
    "ts" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "metric_sample_nodeId_ts_idx" ON "metric_sample"("nodeId", "ts");

-- CreateIndex
CREATE INDEX "metric_sample_scope_containerId_ts_idx" ON "metric_sample"("scope", "containerId", "ts");

-- CreateIndex
CREATE INDEX "metric_sample_orgId_ts_idx" ON "metric_sample"("orgId", "ts");
