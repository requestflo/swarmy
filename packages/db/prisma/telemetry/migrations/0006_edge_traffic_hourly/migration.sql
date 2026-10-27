-- CreateTable
CREATE TABLE "edge_traffic_hourly" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT NOT NULL,
    "region" TEXT,
    "host" TEXT NOT NULL,
    "app" TEXT,
    "bucketStart" DATETIME NOT NULL,
    "requests" INTEGER NOT NULL,
    "errors5xx" INTEGER NOT NULL,
    "status403" INTEGER,
    "status429" INTEGER,
    "durationBuckets" TEXT
);

-- CreateIndex
CREATE INDEX "edge_traffic_hourly_orgId_bucketStart_idx" ON "edge_traffic_hourly"("orgId", "bucketStart");

-- CreateIndex
CREATE INDEX "edge_traffic_hourly_bucketStart_idx" ON "edge_traffic_hourly"("bucketStart");

-- CreateIndex
CREATE UNIQUE INDEX "edge_traffic_hourly_orgId_nodeId_host_bucketStart_key" ON "edge_traffic_hourly"("orgId", "nodeId", "host", "bucketStart");
