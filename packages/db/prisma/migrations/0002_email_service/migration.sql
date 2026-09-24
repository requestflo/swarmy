-- CreateTable
CREATE TABLE "email_config" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "logBodies" BOOLEAN NOT NULL DEFAULT false,
    "systemDomainId" TEXT,
    "inboundTokenHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "email_config_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "email_domain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "selector" TEXT NOT NULL DEFAULT 'swarmy',
    "dkimPrivateKeyEnc" TEXT NOT NULL,
    "dkimPublicKey" TEXT NOT NULL,
    "delivery" TEXT NOT NULL DEFAULT 'direct',
    "relay" JSONB,
    "relayPasswordEnc" TEXT,
    "dmarcPolicy" TEXT NOT NULL DEFAULT 'none',
    "verifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "email_domain_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "email_credential" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "stack" TEXT,
    "smtpUsername" TEXT NOT NULL,
    "smtpPasswordHash" TEXT NOT NULL,
    "apiKeyHash" TEXT NOT NULL,
    "apiKeyPrefix" TEXT NOT NULL,
    "domains" JSONB NOT NULL DEFAULT '[]',
    "webhookUrl" TEXT,
    "webhookSecretEnc" TEXT,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "email_credential_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "email_template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "html" TEXT,
    "text" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "email_template_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "email_suppression" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "detail" TEXT,
    "credentialId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_suppression_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "email_config_orgId_key" ON "email_config"("orgId");

-- CreateIndex
CREATE INDEX "email_domain_orgId_idx" ON "email_domain"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "email_domain_orgId_domain_key" ON "email_domain"("orgId", "domain");

-- CreateIndex
CREATE UNIQUE INDEX "email_credential_smtpUsername_key" ON "email_credential"("smtpUsername");

-- CreateIndex
CREATE UNIQUE INDEX "email_credential_apiKeyHash_key" ON "email_credential"("apiKeyHash");

-- CreateIndex
CREATE INDEX "email_credential_orgId_idx" ON "email_credential"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "email_credential_orgId_name_key" ON "email_credential"("orgId", "name");

-- CreateIndex
CREATE INDEX "email_template_orgId_idx" ON "email_template"("orgId");

-- CreateIndex
CREATE UNIQUE INDEX "email_template_orgId_name_key" ON "email_template"("orgId", "name");

-- CreateIndex
CREATE INDEX "email_suppression_orgId_createdAt_idx" ON "email_suppression"("orgId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppression_orgId_address_key" ON "email_suppression"("orgId", "address");
