-- AlterTable
ALTER TABLE "session" ADD COLUMN "signInMethod" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_org_security_policy" (
    "orgId" TEXT NOT NULL PRIMARY KEY,
    "require2fa" TEXT NOT NULL DEFAULT 'off',
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "enforcedSince" DATETIME,
    "trustIdpMfa" BOOLEAN NOT NULL DEFAULT true,
    "requireSso" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "org_security_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_org_security_policy" ("enforcedSince", "graceDays", "orgId", "require2fa", "trustIdpMfa", "updatedAt") SELECT "enforcedSince", "graceDays", "orgId", "require2fa", "trustIdpMfa", "updatedAt" FROM "org_security_policy";
DROP TABLE "org_security_policy";
ALTER TABLE "new_org_security_policy" RENAME TO "org_security_policy";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
