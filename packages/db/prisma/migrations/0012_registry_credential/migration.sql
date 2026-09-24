-- Third-party registry credentials (GHCR, Docker Hub, GitLab, ECR/GCR/ACR,
-- generic host/user/token). Secret is vault-encrypted; never returned.
-- CreateTable
CREATE TABLE "registry_credential" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'generic',
    "label" TEXT,
    "username" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "lastTestedAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestMessage" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "registry_credential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "registry_credential_orgId_prefix_key" ON "registry_credential"("orgId", "prefix");

-- CreateIndex
CREATE INDEX "registry_credential_orgId_idx" ON "registry_credential"("orgId");

-- AddForeignKey
ALTER TABLE "registry_credential" ADD CONSTRAINT "registry_credential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
