/**
 * The funnel read — a pure SQL builder beside the other RUM ClickHouse reads
 * (`clickhouse.ts`), under the same wall: `org_id = lit(orgId) AND app =
 * lit(app)`, every string through `lit()`, every number through `clampInt()`.
 *
 * One query answers the whole funnel: ClickHouse's `windowFunnel` gives each
 * visit the deepest step it reached in order within the funnel's window, and
 * the outer level groups those into a histogram per release. "Visitors at step
 * k" is then the count of units whose level ≥ k (`funnel-math.ts`).
 *
 * The unit:
 *  - a visit (default). Privacy mode keeps no session id, so a visit is the
 *    daily visitor hash + day, exactly how the overview counts visits;
 *    identified mode uses the session id when the browser sent one.
 *  - a signed-in person (`signedIn`, identified mode only — the service
 *    decides): visits with a verified user id, grouped by that id, deepest
 *    step across their visits.
 *
 * RUM rows carry no release or commit tag, so a visit's release is the swarmy
 * release that was live when it began: `releases` are the stack's deploy
 * times, and the newest one at or before the visit's start names it.
 */
import { clampInt, lit, RUM_EVENTS_TABLE } from './clickhouse';
import { MAX_FUNNEL_STEPS, MIN_FUNNEL_STEPS, type FunnelStep } from './funnels';

export interface FunnelReleaseBoundary {
  /** Swarmy release id. */
  id: string;
  /** When that release went live (ms since epoch). */
  fromMs: number;
}

export interface FunnelQueryInput {
  steps: readonly FunnelStep[];
  /** Look-back in days (1..90). */
  days?: number;
  /** First step → last step within this many minutes (5..10080). */
  windowMinutes?: number;
  /** Count signed-in people instead of visits. */
  signedIn?: boolean;
  /** At most 12 are used, newest first. */
  releases?: readonly FunnelReleaseBoundary[];
}

/** One histogram row: `units` reached exactly `level` steps under `release` ('' = before any known release). */
export interface FunnelRow {
  release: string;
  level: number | string;
  units: number | string;
}

export const MAX_FUNNEL_RELEASES = 12;

/** A path glob → a LIKE pattern: `\ % _` escaped, `*` → `%`. */
export function likePattern(glob: string): string {
  return glob.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/\*/g, '%');
}

function pathPredicate(path: string): string | null {
  if (path === '/*' || path === '*') return null;
  return path.includes('*') ? `path LIKE ${lit(likePattern(path))}` : `path = ${lit(path)}`;
}

/** The step's row condition (a page view on the path, or the named event on it). */
export function stepCondition(step: FunnelStep): string {
  const parts = step.event ? [`kind = 'ev'`, `event_name = ${lit(step.event)}`] : [`kind = 'pv'`];
  const p = pathPredicate(step.path);
  if (p) parts.push(p);
  return `(${parts.join(' AND ')})`;
}

function releaseExpr(releases: readonly FunnelReleaseBoundary[]): string {
  const valid = releases
    .filter((r) => r.id && Number.isFinite(r.fromMs))
    .map((r) => ({ id: r.id.slice(0, 64), fromMs: clampInt(r.fromMs, 0, 0, 8_640_000_000_000) }))
    .sort((a, b) => b.fromMs - a.fromMs)
    .slice(0, MAX_FUNNEL_RELEASES);
  if (valid.length === 0) return `''`;
  const arms = valid.map((r) => `toUnixTimestamp64Milli(started) >= ${r.fromMs}, ${lit(r.id)}`);
  return `multiIf(${arms.join(', ')}, '')`;
}

export function buildFunnelQuery(orgId: string, app: string, q: FunnelQueryInput): string {
  if (q.steps.length < MIN_FUNNEL_STEPS || q.steps.length > MAX_FUNNEL_STEPS) {
    throw new Error(`a funnel has ${MIN_FUNNEL_STEPS}..${MAX_FUNNEL_STEPS} steps`);
  }
  const d = clampInt(q.days, 7, 1, 90);
  const windowS = clampInt(q.windowMinutes, 60, 5, 7 * 1440) * 60;
  const conds = q.steps.map(stepCondition).join(',\n      ');
  const unit = q.signedIn ? 'uid' : 'visit';
  return `SELECT ${releaseExpr(q.releases ?? [])} AS release, level, count() AS units
FROM (
  SELECT ${unit} AS unit, max(lvl) AS level, argMax(start_at, lvl) AS started
  FROM (
    SELECT if(session_id != '', session_id, concat('v', toString(visitor_hash), '-', toString(toDate(ts)))) AS visit,
      anyIf(user_id, user_id != '') AS uid,
      windowFunnel(${windowS})(toDateTime(ts),
      ${conds}) AS lvl,
      min(ts) AS start_at
    FROM ${RUM_EVENTS_TABLE}
    WHERE org_id = ${lit(orgId)} AND app = ${lit(app)} AND ts >= now() - INTERVAL ${d} DAY AND kind IN ('pv', 'ev')
    GROUP BY visit
  )
  WHERE lvl > 0${q.signedIn ? ` AND uid != ''` : ''}
  GROUP BY unit
)
GROUP BY release, level
ORDER BY release, level`;
}
