import type { AnalyticsView } from './rum-shared';

type Kpis = AnalyticsView['kpis'];

/** How this window compares with the one before it. */
export interface KpiDelta {
  /** Visits change as a fraction (0.06 = +6%). */
  visits: number;
  /** Pageviews change as a fraction, when the previous window had any. */
  pageviews: number | null;
  /** Bounce-rate change in percentage points (−2 = two points better). */
  bouncePts: number;
}

/**
 * The previous window, derived from two reads of the same query: the last N
 * days and the last 2N days. Visits, pageviews and bounces are counted per
 * visitor-day, so they subtract cleanly; a median doesn't, so visit length
 * gets no delta. Null when the earlier window has no visits to compare with.
 */
export function kpiDelta(current: Kpis, both: Kpis): KpiDelta | null {
  const prevVisits = both.visits - current.visits;
  if (prevVisits <= 0) return null;
  const prevViews = both.pageviews - current.pageviews;
  const prevBounces = both.bounceRate * both.visits - current.bounceRate * current.visits;
  return {
    visits: current.visits / prevVisits - 1,
    pageviews: prevViews > 0 ? current.pageviews / prevViews - 1 : null,
    bouncePts: (current.bounceRate - prevBounces / prevVisits) * 100,
  };
}

/** "vs last week" for a 7-day window, else "vs previous 30 days". */
export function versus(days: number): string {
  return days === 7 ? 'vs last week' : `vs previous ${days} days`;
}

/** 0.0612 → "+6%"; −0.004 → "±0%". */
export function signedPct(f: number): string {
  const n = Math.round(f * 100);
  return n === 0 ? '±0%' : `${n > 0 ? '+' : '−'}${Math.abs(n)}%`;
}

/** −2.1 → "−2 pts"; 0.3 → "±0 pts". */
export function signedPts(p: number): string {
  const n = Math.round(p);
  return n === 0 ? '±0 pts' : `${n > 0 ? '+' : '−'}${Math.abs(n)} pts`;
}
