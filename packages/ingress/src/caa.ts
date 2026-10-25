/**
 * CAA (RFC 8659): may this certificate authority issue for a host? Pure; the
 * controller does the DNS lookups (board 30, the CAA row).
 *
 * The relevant record set is the first non-empty CAA set found walking up
 * from the host to its parents (never the root): `shop.northwind.dev`, then
 * `northwind.dev`, then `dev`. A wildcard (`*.x`) starts at `x` and reads
 * `issuewild` when the set has any, else `issue`. No set anywhere, or a set
 * with no issue properties, means any CA may issue. An unknown property
 * flagged critical forbids every CA. A lookup that fails (SERVFAIL, timeout)
 * is not "no records": Let's Encrypt refuses to issue until it answers.
 */

export interface CaaRecord {
  /** The flags byte; 128 = critical. */
  critical: number;
  tag: string;
  value: string;
}

/** One name's answer: its records (empty = none there), or the error that stopped the lookup. */
export type CaaLookup = { name: string; records: CaaRecord[] } | { name: string; error: string };

export type CaaState = 'allowed' | 'forbidden' | 'open' | 'unknown';

export interface CaaVerdict {
  state: CaaState;
  /** Where the relevant record set is (null when there is none, or the lookup failed first). */
  at: string | null;
  /** The CA identifiers that set lets issue for this kind of name. */
  allowed: string[];
  /** The relevant set itself. */
  records: CaaRecord[];
  /** Conditions on an allowing record: a pinned ACME account, restricted validation methods. */
  caveats: string[];
  /** Plain words for the Domain detail. */
  say: string;
}

const KNOWN = new Set(['issue', 'issuewild', 'iodef', 'contactemail', 'contactphone', 'issuemail', 'issuevmc']);

/** The names to look up, in order: the host (or a wildcard's base), then each parent, never the root. */
export function caaLookupNames(host: string): string[] {
  const base = host.toLowerCase().replace(/\.$/, '').replace(/^\*\./, '');
  const labels = base.split('.').filter(Boolean);
  return labels.map((_, i) => labels.slice(i).join('.'));
}

/** `letsencrypt.org; accounturi=…` → the issuer domain and its parameters. */
function parseIssue(value: string): { domain: string; params: Record<string, string> } {
  const [head = '', ...rest] = value.split(';');
  const params: Record<string, string> = {};
  for (const p of rest) {
    const eq = p.indexOf('=');
    if (eq > 0) params[p.slice(0, eq).trim().toLowerCase()] = p.slice(eq + 1).trim();
  }
  return { domain: head.trim().toLowerCase(), params };
}

export function evaluateCaa(host: string, lookups: readonly CaaLookup[], ca: { name: string; caa: string }): CaaVerdict {
  const wildcard = host.startsWith('*.');
  for (const l of lookups) {
    if ('error' in l) {
      return { state: 'unknown', at: l.name, allowed: [], records: [], caveats: [], say: `The CAA lookup at ${l.name} failed (${l.error}); ${ca.name} will not issue until it answers.` };
    }
    if (l.records.length === 0) continue;
    const records = l.records;
    const critical = records.find((r) => r.critical & 128 && !KNOWN.has(r.tag.toLowerCase()));
    if (critical) {
      return { state: 'forbidden', at: l.name, allowed: [], records, caveats: [], say: `CAA at ${l.name} has an unknown critical property (${critical.tag}), so no certificate authority may issue.` };
    }
    const wild = records.filter((r) => r.tag.toLowerCase() === 'issuewild');
    const props = wildcard && wild.length ? wild : records.filter((r) => r.tag.toLowerCase() === 'issue');
    if (props.length === 0) {
      return { state: 'open', at: l.name, allowed: [], records, caveats: [], say: `CAA at ${l.name} names no issuer, so any certificate authority may issue, ${ca.name} included.` };
    }
    const parsed = props.map((r) => parseIssue(r.value));
    const allowed = [...new Set(parsed.map((p) => p.domain).filter(Boolean))];
    const mine = parsed.filter((p) => p.domain === ca.caa);
    if (mine.length === 0) {
      const others = allowed.length ? `only ${allowed.join(', ')}` : 'no certificate authority';
      return { state: 'forbidden', at: l.name, allowed, records, caveats: [], say: `CAA at ${l.name} allows ${others}, so ${ca.name} cannot issue. Add 0 ${wildcard ? 'issuewild' : 'issue'} "${ca.caa}" there.` };
    }
    const caveats: string[] = [];
    const need = wildcard ? ['dns-01'] : ['http-01', 'tls-alpn-01', 'dns-01'];
    for (const p of mine) {
      if (p.params.accounturi) caveats.push(`only the ACME account ${p.params.accounturi} may issue; it must be the front door's`);
      const methods = p.params.validationmethods?.split(',').map((m) => m.trim().toLowerCase());
      if (methods && !methods.some((m) => need.includes(m))) caveats.push(`only ${methods.join(', ')} validation is allowed, which the front door does not use for this name`);
    }
    return { state: 'allowed', at: l.name, allowed, records, caveats, say: `CAA at ${l.name} lets ${ca.name} issue (${ca.caa} allowed).` };
  }
  return { state: 'open', at: null, allowed: [], records: [], caveats: [], say: `No CAA records for it or its parents, so any certificate authority may issue, ${ca.name} included.` };
}
