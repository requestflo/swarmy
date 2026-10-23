/**
 * Today's mail for one app, from `email.log` pages filtered by the app's
 * credentials (the log's `credential` is the SMTP username). One row is one
 * recipient event:
 *
 *   sent      = `accepted` today (the mail server took the recipient; SMTP and
 *               HTTP-API sends both go through it)
 *   delivered = `delivered` ÷ the recipients whose outcome is known today
 *               (delivered + bounced + failed + rejected); null when none is
 *
 * A page is newest first and capped at LOG_LIMIT rows. When a full page still
 * starts today, the count is a floor and says so (`capped`), never a guess.
 */
export const LOG_LIMIT = 500;

export interface MailRow {
  ts: string;
  event: string;
}

export interface MailStats {
  sentToday: number;
  /** True when a log page ran out before reaching midnight: sentToday is "at least". */
  capped: boolean;
  outcomes: number;
  delivered: number;
  /** One decimal, or null when no outcome is known yet today. */
  deliveredPct: number | null;
}

const FINAL = new Set(['delivered', 'bounced', 'failed', 'rejected']);

export function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function mailStats(pages: ReadonlyArray<readonly MailRow[]>, now: Date): MailStats {
  const midnight = startOfToday(now).getTime();
  let sentToday = 0;
  let delivered = 0;
  let outcomes = 0;
  let capped = false;
  for (const rows of pages) {
    const today = rows.filter((r) => Date.parse(r.ts) >= midnight);
    if (rows.length >= LOG_LIMIT && today.length === rows.length) capped = true;
    for (const r of today) {
      if (r.event === 'accepted') sentToday++;
      if (FINAL.has(r.event)) outcomes++;
      if (r.event === 'delivered') delivered++;
    }
  }
  const deliveredPct = outcomes ? Math.round((delivered / outcomes) * 1000) / 10 : null;
  return { sentToday, capped, outcomes, delivered, deliveredPct };
}

/** "1,284 sent today · 99.1% delivered" — the board's line, from real counts. */
export function statsLine(s: MailStats): string {
  const sent = `${s.sentToday.toLocaleString('en-GB')}${s.capped ? '+' : ''} sent today`;
  return s.deliveredPct === null ? `${sent} · nothing delivered or bounced yet` : `${sent} · ${s.deliveredPct}% delivered`;
}
