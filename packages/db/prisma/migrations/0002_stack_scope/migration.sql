-- Stack-scoped IA: link org-wide entities to the stack they belong to, and add
-- inbound-webhook templating + custom-domain exposure columns.

-- AlterTable
ALTER TABLE "workflow_def" ADD COLUMN "stackName" TEXT;

-- AlterTable
ALTER TABLE "scheduled_job" ADD COLUMN "stackName" TEXT;

-- AlterTable
ALTER TABLE "inbound_endpoint" ADD COLUMN "stackName" TEXT,
ADD COLUMN "domain" TEXT,
ADD COLUMN "transformTemplate" TEXT,
ADD COLUMN "responseTemplate" TEXT;

-- AlterTable
ALTER TABLE "status_page" ADD COLUMN "stackName" TEXT;

-- CreateIndex
CREATE INDEX "workflow_def_orgId_stackName_idx" ON "workflow_def"("orgId", "stackName");

-- CreateIndex
CREATE INDEX "scheduled_job_orgId_stackName_idx" ON "scheduled_job"("orgId", "stackName");

-- CreateIndex
CREATE INDEX "inbound_endpoint_orgId_stackName_idx" ON "inbound_endpoint"("orgId", "stackName");

-- CreateIndex
CREATE INDEX "status_page_orgId_stackName_idx" ON "status_page"("orgId", "stackName");
