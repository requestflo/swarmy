-- Authenticator-app 2FA (Better Auth twoFactor plugin), session MFA assurance,
-- the org "require 2FA" policy, and the terminal step-up window (launch-blocker #7).

-- AlterTable
ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "session" ADD COLUMN "mfaVerifiedAt" TIMESTAMP(3),
ADD COLUMN "mfaPending" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "failedVerificationCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "two_factor_userId_idx" ON "two_factor"("userId");

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "org_security_policy" (
    "orgId" TEXT NOT NULL,
    "require2fa" TEXT NOT NULL DEFAULT 'off',
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "enforcedSince" TIMESTAMP(3),
    "trustIdpMfa" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "org_security_policy_pkey" PRIMARY KEY ("orgId")
);

-- AddForeignKey
ALTER TABLE "org_security_policy" ADD CONSTRAINT "org_security_policy_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "terminal_policy" ADD COLUMN "mfaMaxAgeMs" INTEGER NOT NULL DEFAULT 900000;
