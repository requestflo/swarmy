-- CreateTable
CREATE TABLE "error_project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "projectId" INTEGER NOT NULL,
    "keyHash" TEXT NOT NULL,
    "keyEnc" TEXT NOT NULL,
    "rateLimitPerMinute" INTEGER NOT NULL DEFAULT 600,
    "rotatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "error_project_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "error_project_projectId_key" ON "error_project"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "error_project_orgId_stack_key" ON "error_project"("orgId", "stack");
