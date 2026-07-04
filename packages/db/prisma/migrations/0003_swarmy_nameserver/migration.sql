-- "Swarmy is the nameserver" (docs/product/edge-network.md).
--
-- DnsZone becomes the registrar-facing artifact (zone identity, mode,
-- delegation pinning, serial); DnsRecord is REPURPOSED from manual geo
-- records (host+region+targetIngress) to manual static records (MX/TXT/…).
-- Old geo records are intentionally NOT carried over: web answers are now
-- derived from ingress + live node state, superseding hand-entered rows.

-- CreateTable
CREATE TABLE "dns_zone" (
    "id" TEXT NOT NULL,
    "orgId" TEXT NOT NULL,
    "zone" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'swarmy-ns',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "ttl" INTEGER NOT NULL DEFAULT 30,
    "serial" INTEGER NOT NULL DEFAULT 1,
    "apexToEdge" BOOLEAN NOT NULL DEFAULT true,
    "autoWww" BOOLEAN NOT NULL DEFAULT true,
    "advertisedNodeIds" JSONB NOT NULL DEFAULT '[]',
    "settings" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dns_zone_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dns_zone_orgId_zone_key" ON "dns_zone"("orgId", "zone");
CREATE INDEX "dns_zone_orgId_idx" ON "dns_zone"("orgId");

ALTER TABLE "dns_zone" ADD CONSTRAINT "dns_zone_orgId_fkey"
    FOREIGN KEY ("orgId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry forward configured zones from the old per-org GeoDnsConfig shape.
-- Old provider values map: coredns → swarmy-ns; cloudflare/route53 keep.
INSERT INTO "dns_zone" ("id", "orgId", "zone", "mode", "enabled", "ttl", "updatedAt")
SELECT
    'dz_' || md5("orgId" || ':' || "zone"),
    "orgId",
    lower("zone"),
    CASE WHEN "provider" = 'coredns' THEN 'swarmy-ns' ELSE "provider" END,
    "enabled",
    "ttl",
    CURRENT_TIMESTAMP
FROM "geo_dns_config"
WHERE "zone" <> '';

-- Repurpose dns_record: manual geo rows are superseded by derived answers.
DELETE FROM "dns_record";

DROP INDEX IF EXISTS "dns_record_orgId_host_region_key";

ALTER TABLE "dns_record"
    DROP COLUMN IF EXISTS "host",
    DROP COLUMN IF EXISTS "region",
    DROP COLUMN IF EXISTS "targetIngress",
    DROP COLUMN IF EXISTS "healthy",
    ADD COLUMN "zoneId" TEXT NOT NULL,
    ADD COLUMN "name" TEXT NOT NULL,
    ADD COLUMN "type" TEXT NOT NULL,
    ADD COLUMN "value" TEXT NOT NULL,
    ADD COLUMN "ttl" INTEGER,
    ADD COLUMN "priority" INTEGER;

CREATE UNIQUE INDEX "dns_record_orgId_zoneId_name_type_value_key"
    ON "dns_record"("orgId", "zoneId", "name", "type", "value");
CREATE INDEX "dns_record_zoneId_idx" ON "dns_record"("zoneId");

ALTER TABLE "dns_record" ADD CONSTRAINT "dns_record_zoneId_fkey"
    FOREIGN KEY ("zoneId") REFERENCES "dns_zone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Shrink geo_dns_config to org-level settings (zone/ttl/provider moved to dns_zone).
ALTER TABLE "geo_dns_config"
    DROP COLUMN IF EXISTS "zone",
    DROP COLUMN IF EXISTS "ttl",
    DROP COLUMN IF EXISTS "provider",
    ADD COLUMN IF NOT EXISTS "settings" JSONB;
