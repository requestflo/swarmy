/**
 * The DNS records a sending domain needs — SPF, DKIM, DMARC (+ the MTA's HELO
 * name for direct delivery) — and the check that tells the operator, record by
 * record, what is missing. Pure: the caller supplies the TXT/A lookups.
 *
 * Two consumers, one source:
 *   - swarmy-dns zones (delegated to swarmy): the records are DERIVED into the
 *     composed zone every reconcile (never stored as DnsRecord rows —
 *     geo-edge-routing invariant #5), via {@link emailZoneRecords};
 *   - domains hosted elsewhere: the Email page shows exactly these values to
 *     add at the operator's DNS host, and {@link checkEmailDns} verifies them.
 */
import type { StaticDnsRecord } from '@swarmy/core/protocol';
import { dkimRecordName, dkimRecordValue, parseTags } from './dkim';

export type Delivery = 'direct' | 'relay';
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export const DMARC_POLICIES: readonly DmarcPolicy[] = ['none', 'quarantine', 'reject'];

export interface EmailDomainDnsInput {
  domain: string;
  selector: string;
  dkimPublicKey: string;
  delivery: Delivery;
  /** Public IPs mail leaves from on direct delivery (the mail node's). */
  sendingIps: string[];
  /** The smarthost's SPF include (e.g. `spf.brevo.com`) on relay delivery. */
  relaySpfInclude?: string | null;
  dmarcPolicy: DmarcPolicy;
  /** The MTA's HELO/EHLO name (direct delivery wants an A record for it). */
  heloHost?: string | null;
}

export type EmailRecordKind = 'spf' | 'dkim' | 'dmarc' | 'helo';

export interface EmailDnsRecord {
  kind: EmailRecordKind;
  /** Absolute name, no trailing dot. */
  name: string;
  type: 'TXT' | 'A' | 'AAAA';
  value: string;
  /** Needed to send at all (DKIM is the verification gate); others are strongly advised. */
  required: boolean;
  /** One plain-words line for the UI. */
  purpose: string;
}

const lc = (s: string): string => s.trim().toLowerCase().replace(/\.+$/, '');
const isV6 = (ip: string): boolean => ip.includes(':');

/** The SPF mechanisms swarmy needs in the domain's `v=spf1` record. */
export function spfMechanisms(input: Pick<EmailDomainDnsInput, 'delivery' | 'sendingIps' | 'relaySpfInclude'>): string[] {
  if (input.delivery === 'relay') {
    return input.relaySpfInclude ? [`include:${lc(input.relaySpfInclude)}`] : [];
  }
  return [...new Set(input.sendingIps)].map((ip) => (isV6(ip) ? `ip6:${ip}` : `ip4:${ip}`));
}

/** `v=spf1 <mechanisms> ~all` (softfail: a fresh setup should not hard-reject its own mail). */
export function spfValue(mechanisms: string[]): string {
  return ['v=spf1', ...mechanisms, '~all'].join(' ');
}

export function dmarcValue(policy: DmarcPolicy): string {
  return `v=DMARC1; p=${policy}; adkim=r; aspf=r`;
}

/** Every record the domain should publish, in display order. */
export function emailDnsRecords(input: EmailDomainDnsInput): EmailDnsRecord[] {
  const domain = lc(input.domain);
  const out: EmailDnsRecord[] = [
    {
      kind: 'dkim',
      name: `${dkimRecordName(input.selector)}.${domain}`,
      type: 'TXT',
      value: dkimRecordValue(input.dkimPublicKey),
      required: true,
      purpose: 'Proves mail signed by swarmy really comes from this domain.',
    },
    {
      kind: 'spf',
      name: domain,
      type: 'TXT',
      value: spfValue(spfMechanisms(input)),
      required: false,
      purpose:
        input.delivery === 'relay'
          ? 'Lists your relay provider as allowed to send for this domain.'
          : 'Lists the mail node’s IP as allowed to send for this domain.',
    },
    {
      kind: 'dmarc',
      name: `_dmarc.${domain}`,
      type: 'TXT',
      value: dmarcValue(input.dmarcPolicy),
      required: false,
      purpose: 'Tells receivers what to do with mail that fails SPF and DKIM.',
    },
  ];
  if (input.delivery === 'direct' && input.heloHost) {
    const helo = lc(input.heloHost);
    for (const ip of [...new Set(input.sendingIps)]) {
      out.push({
        kind: 'helo',
        name: helo,
        type: isV6(ip) ? 'AAAA' : 'A',
        value: ip,
        required: false,
        purpose: 'The name the mail server introduces itself as must resolve to its IP.',
      });
    }
  }
  return out;
}

/** Name relative to a zone ('@' for the apex), or null when outside it. */
export function relativeTo(name: string, zone: string): string | null {
  const n = lc(name);
  const z = lc(zone);
  if (n === z) return '@';
  return n.endsWith(`.${z}`) ? n.slice(0, -(z.length + 1)) : null;
}

/**
 * Records to fold into a swarmy-dns zone. The SPF record is skipped when the
 * zone already carries a manual `v=spf1` at that name (two SPF records is a
 * permanent SPF error for every receiver) — {@link checkEmailDns} then reports
 * the manual one as needing our mechanisms merged in.
 */
export function emailZoneRecords(
  zone: string,
  domains: EmailDomainDnsInput[],
  manual: ReadonlyArray<Pick<StaticDnsRecord, 'name' | 'type' | 'value'>> = [],
): StaticDnsRecord[] {
  const manualSpf = new Set(
    manual
      .filter((r) => r.type === 'TXT' && /^\s*"?v=spf1\b/i.test(r.value))
      .map((r) => (r.name === '@' || r.name === '' ? '@' : lc(r.name))),
  );
  const out: StaticDnsRecord[] = [];
  const seen = new Set<string>();
  for (const d of domains) {
    for (const r of emailDnsRecords(d)) {
      const rel = relativeTo(r.name, zone);
      if (rel === null) continue;
      if (r.kind === 'spf' && manualSpf.has(rel)) continue;
      const key = `${rel}|${r.type}|${r.value}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: rel, type: r.type, value: r.value });
    }
  }
  return out;
}

// ── checks ───────────────────────────────────────────────────────────────────

export interface DnsLookups {
  /** TXT records at a name, each record's strings joined. Missing name → []. */
  txt(name: string): Promise<string[]>;
  /** A/AAAA addresses at a name. Missing → []. */
  addresses(name: string): Promise<string[]>;
}

export type RecordStatus = 'ok' | 'missing' | 'mismatch' | 'error';

export interface EmailDnsCheck extends EmailDnsRecord {
  status: RecordStatus;
  /** What DNS currently answers (TXT values / addresses at the name). */
  found: string[];
  /** Plain-words next step when not ok. */
  hint?: string;
}

async function safe<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Check one record against live DNS. */
export async function checkRecord(r: EmailDnsRecord, lookups: DnsLookups): Promise<EmailDnsCheck> {
  if (r.type !== 'TXT') {
    const res = await safe(() => lookups.addresses(r.name));
    if (!res.ok) return { ...r, status: 'error', found: [], hint: `DNS lookup failed: ${res.error}` };
    const found = res.value;
    if (found.includes(r.value)) return { ...r, status: 'ok', found };
    return {
      ...r,
      status: found.length ? 'mismatch' : 'missing',
      found,
      hint: found.length ? `${r.name} points elsewhere; point it at ${r.value}.` : `Add ${r.type} ${r.name} → ${r.value}.`,
    };
  }
  const res = await safe(() => lookups.txt(r.name));
  if (!res.ok) return { ...r, status: 'error', found: [], hint: `DNS lookup failed: ${res.error}` };
  const found = res.value.map((v) => v.trim());
  switch (r.kind) {
    case 'dkim': {
      const want = parseTags(r.value).p;
      const keys = found.map(parseTags).filter((t) => t.p !== undefined);
      if (keys.some((t) => (t.p ?? '').replace(/\s+/g, '') === want)) return { ...r, status: 'ok', found };
      return keys.length
        ? { ...r, status: 'mismatch', found, hint: 'A different DKIM key is published under this selector; replace it with the value shown.' }
        : { ...r, status: 'missing', found, hint: `Add a TXT record at ${r.name} with the value shown.` };
    }
    case 'spf': {
      const spf = found.filter((v) => /^v=spf1\b/i.test(v));
      if (spf.length === 0) return { ...r, status: 'missing', found, hint: `Add a TXT record at ${r.name}: ${r.value}` };
      if (spf.length > 1)
        return { ...r, status: 'mismatch', found, hint: 'There are several SPF records; receivers reject all of them. Merge them into one.' };
      const have = spf[0]!.toLowerCase().split(/\s+/);
      const need = r.value.split(/\s+/).filter((m) => /^(ip4|ip6|include):/.test(m));
      const missing = need.filter((m) => !have.includes(m.toLowerCase()));
      if (missing.length === 0) return { ...r, status: 'ok', found };
      return { ...r, status: 'mismatch', found, hint: `Your SPF record does not include ${missing.join(' ')}; add it before the final "all".` };
    }
    case 'dmarc': {
      const dmarc = found.filter((v) => /^v=DMARC1\b/i.test(v));
      if (dmarc.length === 1) return { ...r, status: 'ok', found };
      return dmarc.length
        ? { ...r, status: 'mismatch', found, hint: 'There are several DMARC records; keep exactly one.' }
        : { ...r, status: 'missing', found, hint: `Add a TXT record at ${r.name}: ${r.value}` };
    }
    default:
      return { ...r, status: found.includes(r.value) ? 'ok' : 'missing', found };
  }
}

export interface EmailDomainCheck {
  records: EmailDnsCheck[];
  /** The verification gate: the DKIM key is published. */
  dkimOk: boolean;
  /** Everything (SPF, DKIM, DMARC, HELO) is in place. */
  allOk: boolean;
  checkedAt: string;
}

export async function checkEmailDns(input: EmailDomainDnsInput, lookups: DnsLookups, now = new Date()): Promise<EmailDomainCheck> {
  const records = await Promise.all(emailDnsRecords(input).map((r) => checkRecord(r, lookups)));
  return {
    records,
    dkimOk: records.some((r) => r.kind === 'dkim' && r.status === 'ok'),
    allOk: records.every((r) => r.status === 'ok'),
    checkedAt: now.toISOString(),
  };
}

/** Lowercase + validate a domain name (throws a plain-words error). */
export function normalizeEmailDomain(raw: string): string {
  const d = lc(raw);
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(d)) {
    throw new Error(`"${raw}" is not a domain name like example.com`);
  }
  return d;
}

/** The domain part of an address (`Name <a@b.com>` accepted). */
export function addressDomain(address: string): string | null {
  const m = /<([^>]+)>/.exec(address);
  const a = (m ? m[1]! : address).trim();
  const at = a.lastIndexOf('@');
  return at > 0 ? lc(a.slice(at + 1)) : null;
}

/** The bare lowercase address (`Name <a@b.com>` → `a@b.com`). */
export function bareAddress(address: string): string {
  const m = /<([^>]+)>/.exec(address);
  return (m ? m[1]! : address).trim().toLowerCase();
}
