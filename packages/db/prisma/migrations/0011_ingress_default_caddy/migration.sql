-- New orgs default to swarmy's Caddy edge, enabled (owner decision
-- 2026-09-24). Column defaults only — existing rows keep their driver.
-- AlterTable
ALTER TABLE "ingress_config" ALTER COLUMN "driver" SET DEFAULT 'CADDY',
ALTER COLUMN "enabled" SET DEFAULT true;
