-- CreateTable
CREATE TABLE "cost_budgets" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "monthlyUsd" REAL,
    "weeklySummary" BOOLEAN NOT NULL DEFAULT false,
    "weeklyChannelIds" JSONB NOT NULL DEFAULT '[]',
    "lastWeeklyAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "cost_budgets_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "cost_budgets_orgId_key" ON "cost_budgets"("orgId");
