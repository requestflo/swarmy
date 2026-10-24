-- AlterTable
ALTER TABLE "edge_traffic_rollup" ADD COLUMN "durationBuckets" TEXT;
ALTER TABLE "edge_traffic_rollup" ADD COLUMN "status403" INTEGER;
ALTER TABLE "edge_traffic_rollup" ADD COLUMN "status429" INTEGER;
