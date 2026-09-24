-- git-apps Phase 2: provider connections (GitHub App installations, GitLab
-- OAuth, Gitea, generic), and GitRepo as a per-(repo, branch, swarmy.yaml)
-- app binding. Every token/secret is vault-encrypted; never returned.

-- AlterEnum
ALTER TYPE "GitProviderKind" ADD VALUE 'GITEA';
ALTER TYPE "GitProviderKind" ADD VALUE 'GENERIC';

-- CreateTable
CREATE TABLE "github_app" (
    "id" TEXT NOT NULL,
    "webBase" TEXT NOT NULL DEFAULT 'https://github.com',
    "appId" INTEGER NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "htmlUrl" TEXT NOT NULL,
    "ownerLogin" TEXT,
    "clientId" TEXT NOT NULL,
    "clientSecretEnc" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "webhookSecretEnc" TEXT NOT NULL,
    "createdByOrgId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_app_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "git_connection" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "kind" "GitProviderKind" NOT NULL,
    "displayName" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "githubAppId" TEXT,
    "installationId" TEXT,
    "account" TEXT,
    "clientId" TEXT,
    "clientSecretEnc" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenUser" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "git_connection_pkey" PRIMARY KEY ("id")
);

-- AlterTable
ALTER TABLE "git_repo" ADD COLUMN "connectionId" TEXT,
ADD COLUMN "externalRepoId" TEXT,
ADD COLUMN "fullName" TEXT,
ADD COLUMN "configPath" TEXT NOT NULL DEFAULT 'swarmy.yaml',
ADD COLUMN "appName" TEXT,
ADD COLUMN "lastAppliedSha" TEXT,
ADD COLUMN "deployKeyEnc" TEXT,
ADD COLUMN "deployKeyPublic" TEXT;

-- DropIndex
DROP INDEX "git_repo_orgId_url_key";

-- CreateIndex
CREATE UNIQUE INDEX "git_repo_orgId_url_branch_configPath_key" ON "git_repo"("orgId", "url", "branch", "configPath");
CREATE INDEX "git_repo_connectionId_idx" ON "git_repo"("connectionId");
CREATE INDEX "git_repo_externalRepoId_idx" ON "git_repo"("externalRepoId");
CREATE UNIQUE INDEX "github_app_webBase_appId_key" ON "github_app"("webBase", "appId");
CREATE UNIQUE INDEX "git_connection_githubAppId_installationId_key" ON "git_connection"("githubAppId", "installationId");
CREATE INDEX "git_connection_orgId_idx" ON "git_connection"("orgId");

-- AddForeignKey
ALTER TABLE "git_repo" ADD CONSTRAINT "git_repo_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "git_connection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "git_connection" ADD CONSTRAINT "git_connection_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "git_connection" ADD CONSTRAINT "git_connection_githubAppId_fkey" FOREIGN KEY ("githubAppId") REFERENCES "github_app"("id") ON DELETE CASCADE ON UPDATE CASCADE;
