-- AlterTable
ALTER TABLE "build" ADD COLUMN "builder" TEXT;
ALTER TABLE "build" ADD COLUMN "cacheRef" TEXT;
ALTER TABLE "build" ADD COLUMN "cachedSteps" INTEGER;
ALTER TABLE "build" ADD COLUMN "detectJson" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_image_gc_policy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ON_HEALTHCHECK',
    "keepProd" BOOLEAN NOT NULL DEFAULT true,
    "days" INTEGER,
    "cacheMaxAgeDays" INTEGER NOT NULL DEFAULT 14,
    "cacheMaxGb" INTEGER NOT NULL DEFAULT 20,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "image_gc_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_image_gc_policy" ("createdAt", "days", "id", "keepProd", "mode", "orgId", "updatedAt") SELECT "createdAt", "days", "id", "keepProd", "mode", "orgId", "updatedAt" FROM "image_gc_policy";
DROP TABLE "image_gc_policy";
ALTER TABLE "new_image_gc_policy" RENAME TO "image_gc_policy";
CREATE UNIQUE INDEX "image_gc_policy_orgId_key" ON "image_gc_policy"("orgId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
