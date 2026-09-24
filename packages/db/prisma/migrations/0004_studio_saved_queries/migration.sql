-- CreateTable
CREATE TABLE "studio_saved_query" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "target" TEXT,
    "engine" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "statement" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "studio_saved_query_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "studio_saved_query_orgId_stack_idx" ON "studio_saved_query"("orgId", "stack");

-- CreateIndex
CREATE UNIQUE INDEX "studio_saved_query_orgId_stack_name_key" ON "studio_saved_query"("orgId", "stack", "name");
