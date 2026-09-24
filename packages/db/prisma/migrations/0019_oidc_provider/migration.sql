-- swarmy as an OpenID Connect provider (@better-auth/oauth-provider + jwt
-- plugin): OIDC clients (NetBird first), tokens, consents and the JWKS.


-- CreateTable
CREATE TABLE "oidc_client" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" JSONB,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" JSONB,
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" JSONB,
    "postLogoutRedirectUris" JSONB,
    "tokenEndpointAuthMethod" TEXT,
    "grantTypes" JSONB,
    "responseTypes" JSONB,
    "public" BOOLEAN,
    "type" TEXT,
    "requirePKCE" BOOLEAN,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "oidc_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_refresh_token" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT NOT NULL,
    "referenceId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "revoked" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "scopes" JSONB,

    CONSTRAINT "oidc_refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_access_token" (
    "id" TEXT NOT NULL,
    "token" TEXT,
    "clientId" TEXT NOT NULL,
    "sessionId" TEXT,
    "userId" TEXT,
    "referenceId" TEXT,
    "refreshId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "scopes" JSONB,

    CONSTRAINT "oidc_access_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oidc_consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "referenceId" TEXT,
    "scopes" JSONB,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "oidc_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oidc_client_clientId_key" ON "oidc_client"("clientId");

-- CreateIndex
CREATE INDEX "oidc_client_userId_idx" ON "oidc_client"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_refresh_token_token_key" ON "oidc_refresh_token"("token");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_clientId_idx" ON "oidc_refresh_token"("clientId");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_sessionId_idx" ON "oidc_refresh_token"("sessionId");

-- CreateIndex
CREATE INDEX "oidc_refresh_token_userId_idx" ON "oidc_refresh_token"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "oidc_access_token_token_key" ON "oidc_access_token"("token");

-- CreateIndex
CREATE INDEX "oidc_access_token_clientId_idx" ON "oidc_access_token"("clientId");

-- CreateIndex
CREATE INDEX "oidc_access_token_sessionId_idx" ON "oidc_access_token"("sessionId");

-- CreateIndex
CREATE INDEX "oidc_access_token_userId_idx" ON "oidc_access_token"("userId");

-- CreateIndex
CREATE INDEX "oidc_access_token_refreshId_idx" ON "oidc_access_token"("refreshId");

-- CreateIndex
CREATE INDEX "oidc_consent_clientId_idx" ON "oidc_consent"("clientId");

-- CreateIndex
CREATE INDEX "oidc_consent_userId_idx" ON "oidc_consent"("userId");

-- AddForeignKey
ALTER TABLE "oidc_refresh_token" ADD CONSTRAINT "oidc_refresh_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_access_token" ADD CONSTRAINT "oidc_access_token_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_access_token" ADD CONSTRAINT "oidc_access_token_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "oidc_refresh_token"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oidc_consent" ADD CONSTRAINT "oidc_consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "oidc_client"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;

