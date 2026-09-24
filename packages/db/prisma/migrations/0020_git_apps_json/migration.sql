-- git-apps: portable column shapes (no native arrays, no JSON column defaults).
-- Pre-launch: the array columns held only routing hints (re-derived on the next
-- plan) and confirm history, so they are recreated as JSON rather than cast.

-- AlterTable
ALTER TABLE "app_plan" ALTER COLUMN "planJson" DROP NOT NULL,
ALTER COLUMN "planJson" DROP DEFAULT,
ALTER COLUMN "desiredJson" DROP NOT NULL,
ALTER COLUMN "desiredJson" DROP DEFAULT,
ALTER COLUMN "issuesJson" DROP NOT NULL,
ALTER COLUMN "issuesJson" DROP DEFAULT,
ALTER COLUMN "resultsJson" DROP NOT NULL,
ALTER COLUMN "resultsJson" DROP DEFAULT,
DROP COLUMN "confirmedIds",
ADD COLUMN     "confirmedIds" JSONB;

-- AlterTable
ALTER TABLE "git_repo" DROP COLUMN "envBranches",
ADD COLUMN     "envBranches" JSONB;
