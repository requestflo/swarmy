import { ESTATE_UPTIME_MIN_HOURS, type EstateUptimeSource, type EstateUptimeView } from '@swarmy/core';

/**
 * The estate's uptime as the phone glance says it (`estate.uptime`): the
 * figure ("99.97% up"), what it's based on ("30 days, from status checks"),
 * and the Controls tech line. Without enough data there is no figure, only
 * the words saying so.
 */
export interface UptimeWords {
  figure: string | null;
  basis: string;
  tech: string;
}

const FROM: Record<EstateUptimeSource, string> = {
  'status-checks': 'from status checks',
  'edge-requests': 'from the edges’ requests',
};

/** "99.97", "99.9", "100" — the view already floored it. */
export function pctWords(pct: number): string {
  return String(Number(pct.toFixed(2)));
}

/** "30 days" when it saw (nearly) the whole window, else "the last 7 days" / "the last day". */
export function spanWords(coveredHours: number, windowDays: number): string {
  if (coveredHours >= windowDays * 24 - 24) return `${windowDays} days`;
  const days = Math.max(1, Math.floor(coveredHours / 24));
  return days === 1 ? 'the last day' : `the last ${days} days`;
}

export function uptimeWords(v: EstateUptimeView): UptimeWords {
  const seen = `${Math.round(v.coveredHours)} h seen`;
  if (v.state !== 'ok' || v.pct === null || !v.source) {
    return {
      figure: null,
      basis: 'Not enough data for uptime yet',
      tech: `estate.uptime · ${seen}${v.source ? ` ${FROM[v.source]}` : ''}, needs ${ESTATE_UPTIME_MIN_HOURS}`,
    };
  }
  return {
    figure: `${pctWords(v.pct)}% up`,
    basis: `${spanWords(v.coveredHours, v.windowDays)}, ${FROM[v.source]}`,
    tech: `estate.uptime · ${seen} · ${v.downMinutes ?? 0} min not answering`,
  };
}
