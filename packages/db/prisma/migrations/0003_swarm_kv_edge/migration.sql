-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "dns_record";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "dns_zone";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "geo_dns_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ingress_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "mesh_config";
PRAGMA foreign_keys=on;

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "observability_config";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "operation_run" (
    "orgId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "run" JSONB NOT NULL,
    "updatedAt" DATETIME NOT NULL,

    PRIMARY KEY ("orgId", "kind"),
    CONSTRAINT "operation_run_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
