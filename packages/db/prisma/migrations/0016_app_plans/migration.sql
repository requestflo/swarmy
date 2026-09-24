-- git-apps Phase 3: the GitOps apply loop's plan history + per-binding settings.

-- AlterTable
ALTER TABLE "git_repo" ADD COLUMN "requireApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "envBranches" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "app_plan" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "repoId" TEXT NOT NULL,
    "environment" TEXT NOT NULL,
    "stack" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "prNumber" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL,
    "planJson" JSONB NOT NULL DEFAULT '{}',
    "desiredJson" JSONB NOT NULL DEFAULT '{}',
    "issuesJson" JSONB NOT NULL DEFAULT '[]',
    "ledgerJson" JSONB,
    "resultsJson" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "confirmedIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "confirmedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "appliedAt" TIMESTAMP(3),

    CONSTRAINT "app_plan_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "app_plan_repoId_environment_sha_trigger_prNumber_key" ON "app_plan"("repoId", "environment", "sha", "trigger", "prNumber");
CREATE INDEX "app_plan_orgId_createdAt_idx" ON "app_plan"("orgId", "createdAt");
CREATE INDEX "app_plan_repoId_environment_createdAt_idx" ON "app_plan"("repoId", "environment", "createdAt");

-- AddForeignKey
ALTER TABLE "app_plan" ADD CONSTRAINT "app_plan_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_plan" ADD CONSTRAINT "app_plan_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "git_repo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
