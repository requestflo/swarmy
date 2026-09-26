-- AlterTable
ALTER TABLE "alert_rule" ADD COLUMN "mutedUntil" DATETIME;

-- CreateTable
CREATE TABLE "alert_quiet_hours" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "start" TEXT NOT NULL DEFAULT '22:00',
    "end" TEXT NOT NULL DEFAULT '07:00',
    "timeZone" TEXT NOT NULL DEFAULT 'UTC',
    "criticalPages" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "alert_quiet_hours_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_alert_event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "ruleId" TEXT,
    "signal" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'warning',
    "resource" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'FIRING',
    "notify" TEXT NOT NULL DEFAULT 'SENT',
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    CONSTRAINT "alert_event_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "alert_event_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "alert_rule" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_alert_event" ("firedAt", "id", "message", "orgId", "resolvedAt", "resource", "ruleId", "severity", "signal", "status") SELECT "firedAt", "id", "message", "orgId", "resolvedAt", "resource", "ruleId", "severity", "signal", "status" FROM "alert_event";
DROP TABLE "alert_event";
ALTER TABLE "new_alert_event" RENAME TO "alert_event";
CREATE INDEX "alert_event_orgId_status_firedAt_idx" ON "alert_event"("orgId", "status", "firedAt");
CREATE INDEX "alert_event_ruleId_resource_status_idx" ON "alert_event"("ruleId", "resource", "status");
CREATE INDEX "alert_event_orgId_status_notify_idx" ON "alert_event"("orgId", "status", "notify");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "alert_quiet_hours_orgId_key" ON "alert_quiet_hours"("orgId");
