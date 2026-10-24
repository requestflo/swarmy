import type { HostBlocked } from '@/lib/host-blocked';

/** "0.4" / "12" / "1.2k" — a small rate keeps its decimal, a big one rounds. */
export function rateText(n: number): string {
  if (n < 10) return String(Math.round(n * 10) / 10);
  return n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n)}`;
}

/**
 * The protections' receipt (board 30): what the front door turned away at
 * this address, as the edge counted it. Blocked = 403 + 429 answers; Caddy's
 * `code` label can't say which rule answered (or whether the app did), so the
 * number belongs to the address, never to one card. Null = no honest number.
 */
export function blockedWords(b: HostBlocked | null, host: string, service: string): { head: string; note: string; tech: string } | null {
  if (!b) return null;
  const last = `the last ${b.windowMinutes} minutes`;
  const tech =
    `traffic.now.hosts · ${host} · 403 ${rateText(b.forbiddenPerMin)}/min + 429 ${rateText(b.tooManyPerMin)}/min at the edge · ` +
    'includes 403/429 the app sends itself (Caddy’s code label can’t tell them apart) · ' +
    'abort rules (IPs, countries, bots, required headers) drop the connection and aren’t counted';
  if (b.perMin === 0) return { head: 'Nothing blocked', note: `in ${last}.`, tech };
  return {
    head: `Blocked ${rateText(b.perMin)} a minute`,
    note: `over ${last}: refused at the front door, plus any refusals ${service} sends itself.`,
    tech,
  };
}
