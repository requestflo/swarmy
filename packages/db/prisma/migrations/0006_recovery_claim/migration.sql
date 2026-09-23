-- Catch-up: schema changes that reached dev via db push but never got a migration,
-- so every real install (lite + standard) was missing them.
-- AlterTable
ALTER TABLE "stack" DROP COLUMN IF EXISTS "telemetryEnabled";

-- CreateTable
CREATE TABLE "recovery_claim" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "nodeId" TEXT,
    "hostname" TEXT NOT NULL,
    "claimHash" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "credentialEnc" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "recovery_claim_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "recovery_claim_claimHash_key" ON "recovery_claim"("claimHash");

-- CreateIndex
CREATE INDEX "recovery_claim_orgId_status_idx" ON "recovery_claim"("orgId", "status");

-- CreateIndex
CREATE INDEX "recovery_claim_hostname_idx" ON "recovery_claim"("hostname");

-- AddForeignKey
ALTER TABLE "recovery_claim" ADD CONSTRAINT "recovery_claim_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recovery_claim" ADD CONSTRAINT "recovery_claim_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "node"("id") ON DELETE SET NULL ON UPDATE CASCADE;

