-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_invitation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" DATETIME NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stackName" TEXT,
    "requireSso" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_invitation" ("createdAt", "email", "expiresAt", "id", "inviterId", "organizationId", "role", "stackName", "status") SELECT "createdAt", "email", "expiresAt", "id", "inviterId", "organizationId", "role", "stackName", "status" FROM "invitation";
DROP TABLE "invitation";
ALTER TABLE "new_invitation" RENAME TO "invitation";
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");
CREATE TABLE "new_invite_link" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "stackName" TEXT,
    "expiresAt" DATETIME,
    "maxUses" INTEGER,
    "uses" INTEGER NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requireSso" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "invite_link_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "invite_link_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_invite_link" ("createdAt", "createdById", "expiresAt", "id", "maxUses", "orgId", "prefix", "revokedAt", "role", "stackName", "tokenHash", "uses") SELECT "createdAt", "createdById", "expiresAt", "id", "maxUses", "orgId", "prefix", "revokedAt", "role", "stackName", "tokenHash", "uses" FROM "invite_link";
DROP TABLE "invite_link";
ALTER TABLE "new_invite_link" RENAME TO "invite_link";
CREATE UNIQUE INDEX "invite_link_tokenHash_key" ON "invite_link"("tokenHash");
CREATE INDEX "invite_link_orgId_idx" ON "invite_link"("orgId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
