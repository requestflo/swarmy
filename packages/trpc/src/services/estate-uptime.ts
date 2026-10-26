import {
  EDGE_DOWN_5XX_SHARE,
  EDGE_DOWN_MIN_REQUESTS,
  EDGE_SLOT_MINUTES,
  ESTATE_UPTIME_DAYS,
  STATUS_CHECK_SLOT_MINUTES,
  estateUptimeFrom,
  type EstateUptimeView,
  type UptimeSlots,
} from '@swarmy/core';
import { telemetryOf, type OrgContext } from '../context';

/**
 * Estate uptime over 30 days (`estate.uptime`): count the slots each source
 * saw and the ones where something wasn't answering, in SQL (a month of
 * minute samples is far too many rows to fold in JS), then let the pure
 * `estateUptimeFrom` pick the source. Both reads are org-scoped; a store that
 * can't be read counts as no slots (so "not enough data", never 100%).
 *
 * Timestamps are ISO-8601 text (the bun-sqlite adapter), so strftime reads
 * them and a Date bound parameter compares as the same text.
 */

const DAY_MS = 24 * 60 * 60_000;

interface CountRow {
  slots: number | bigint | null;
  down: number | bigint | null;
}

const n = (v: number | bigint | null | undefined): number => Number(v ?? 0);

/** Status-page samples: one slot per minute that had any; down when any component was DOWN. */
export async function statusCheckSlots(ctx: OrgContext, since: Date): Promise<UptimeSlots> {
  const rows = await ctx.db
    .$queryRaw<CountRow[]>`
      SELECT COUNT(*) AS "slots", COALESCE(SUM("down"), 0) AS "down" FROM (
        SELECT strftime('%Y-%m-%dT%H:%M', "at") AS "slot", MAX("status" = 'DOWN') AS "down"
        FROM "uptime_sample"
        WHERE "orgId" = ${ctx.activeOrgId} AND "at" >= ${since}
        GROUP BY 1
      )`
    .catch(() => [] as CountRow[]);
  return { slots: n(rows[0]?.slots), downSlots: n(rows[0]?.down), slotMinutes: STATUS_CHECK_SLOT_MINUTES };
}

/**
 * Edge rollups: a slot per 5-minute bucket an edge reported (its coverage row,
 * host ''); down when a routed app (host rows with an app) had enough requests
 * and half or more failed with a 5xx, summed over every edge.
 */
export async function edgeSlots(ctx: OrgContext, since: Date): Promise<UptimeSlots> {
  const tdb = telemetryOf(ctx);
  const orgId = ctx.activeOrgId;
  const [covered, down] = await Promise.all([
    tdb.$queryRaw<CountRow[]>`
      SELECT COUNT(DISTINCT "bucketStart") AS "slots", 0 AS "down"
      FROM "edge_traffic_rollup"
      WHERE "orgId" = ${orgId} AND "host" = '' AND "bucketStart" >= ${since}`.catch(() => [] as CountRow[]),
    tdb.$queryRaw<CountRow[]>`
      SELECT 0 AS "slots", COUNT(DISTINCT "b") AS "down" FROM (
        SELECT "bucketStart" AS "b", "app", SUM("requests") AS "r", SUM("errors5xx") AS "e"
        FROM "edge_traffic_rollup"
        WHERE "orgId" = ${orgId} AND "host" <> '' AND "app" IS NOT NULL AND "bucketStart" >= ${since}
        GROUP BY 1, 2
      )
      WHERE "r" >= ${EDGE_DOWN_MIN_REQUESTS} AND "e" >= "r" * ${EDGE_DOWN_5XX_SHARE}`.catch(() => [] as CountRow[]),
  ]);
  const slots = n(covered[0]?.slots);
  return { slots, downSlots: Math.min(slots, n(down[0]?.down)), slotMinutes: EDGE_SLOT_MINUTES };
}

/** One number for the estate over the last 30 days, and what it's based on. */
export async function estateUptime(ctx: OrgContext, now = Date.now()): Promise<EstateUptimeView> {
  const since = new Date(now - ESTATE_UPTIME_DAYS * DAY_MS);
  const [status, edges] = await Promise.all([statusCheckSlots(ctx, since), edgeSlots(ctx, since)]);
  return estateUptimeFrom(status, edges, ESTATE_UPTIME_DAYS);
}
