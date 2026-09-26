-- CreateTable
CREATE TABLE "edge_traffic_rollup" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "region" TEXT,
    "host" TEXT NOT NULL,
    "app" TEXT,
    "bucketStart" DATETIME NOT NULL,
    "requests" INTEGER NOT NULL,
    "errors5xx" INTEGER NOT NULL
);

-- CreateIndex
CREATE INDEX "edge_traffic_rollup_orgId_bucketStart_idx" ON "edge_traffic_rollup"("orgId", "bucketStart");

-- CreateIndex
CREATE INDEX "edge_traffic_rollup_bucketStart_idx" ON "edge_traffic_rollup"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "edge_traffic_rollup_orgId_nodeId_host_bucketStart_key" ON "edge_traffic_rollup"("orgId", "nodeId", "host", "bucketStart");
