-- AlterTable
ALTER TABLE "build" ADD COLUMN "releaseId" TEXT;

-- CreateTable
CREATE TABLE "build_stage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "buildId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL,
    "finishedAt" DATETIME,
    "outcome" TEXT NOT NULL DEFAULT 'running',
    "factsJson" JSONB,
    CONSTRAINT "build_stage_buildId_fkey" FOREIGN KEY ("buildId") REFERENCES "build" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "build_stage_buildId_stage_key" ON "build_stage"("buildId", "stage");

-- CreateIndex
CREATE INDEX "build_releaseId_idx" ON "build"("releaseId");
