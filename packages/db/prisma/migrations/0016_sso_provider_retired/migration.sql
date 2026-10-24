-- CreateTable
CREATE TABLE "sso_provider_retired" (
    "providerId" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "retiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
