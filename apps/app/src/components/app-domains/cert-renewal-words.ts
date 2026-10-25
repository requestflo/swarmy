/**
 * Pure: when the front door renews the certificate, and the renewals swarmy
 * saw, said for the Certificate card (board 30). The controller works the
 * window out (`ingress.certFacts` renewal: a third of the lifetime left, as
 * Caddy does); without it, the 90-day rule of thumb from the expiry alone.
 */
import type { Tone } from '@/components/calm/tone';
import type { CertFacts } from './cert-facts-model';
import { renewsIn } from './cert-model';

const day = (iso: string): string => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/** The line under the issuer: "renews itself in 29 days" / "renewing now". */
export function renewsLine(facts: CertFacts | null, expiresAt: string | null, now = Date.now()): { text: string; tone: Tone } | null {
  const w = facts?.renewal;
  if (w) {
    if (w.state === 'expired') return null;
    if (w.state === 'due') return { text: 'renewing now · the front door keeps trying until it lands', tone: 'info' };
    return { text: `renews itself in ${w.daysUntil} day${w.daysUntil === 1 ? '' : 's'}`, tone: 'ok' };
  }
  const d = renewsIn(expiresAt, now);
  return d === null ? null : { text: `renews itself in ${d} day${d === 1 ? '' : 's'}`, tone: 'ok' };
}

/** The Controls line: the rule, said honestly. */
export function renewalTech(facts: CertFacts | null): string | null {
  const w = facts?.renewal;
  if (!w) return null;
  return `Caddy renews with a third of the lifetime left: around ${day(w.renewAt)} for this ${w.lifetimeDays}-day certificate · Let's Encrypt can suggest another moment (ARI), which Caddy follows`;
}

/** One renewal seen, as a row: when, and what happened. */
export function renewalRows(facts: CertFacts | null): Array<{ when: string; what: string; tech: string }> {
  return (facts?.renewals ?? []).map((r) => ({
    when: day(r.at),
    what: `${r.by === 'request' ? 'renewed when asked' : 'renewed itself'}${r.issuer ? ` · ${r.issuer}` : ''}`,
    tech: `notBefore ${r.at} · replaced the one issued ${r.replaced}`,
  }));
}
