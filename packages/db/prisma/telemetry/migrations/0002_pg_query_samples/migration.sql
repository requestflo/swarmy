-- CreateTable
CREATE TABLE "pg_query_sample" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "calls" INTEGER NOT NULL,
    "totalMs" REAL NOT NULL,
    "rows" INTEGER NOT NULL,
    "ts" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "pg_query_text" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "queryId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "lastSeen" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "pg_query_sample_orgId_stack_target_ts_idx" ON "pg_query_sample"("orgId", "stack", "target", "ts");

-- CreateIndex
CREATE INDEX "pg_query_sample_ts_idx" ON "pg_query_sample"("ts");

-- CreateIndex
CREATE INDEX "pg_query_text_lastSeen_idx" ON "pg_query_text"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "pg_query_text_orgId_stack_target_queryId_key" ON "pg_query_text"("orgId", "stack", "target", "queryId");
