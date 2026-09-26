/**
 * Custom-domain DNS guidance, verification and certificate status — pure.
 *
 * The controller does the IO (DNS-over-HTTPS lookups against public resolvers,
 * a TLS handshake against each edge); everything that DECIDES lives here so it
 * is golden-tested and shared by the tRPC service, the REST front door, the
 * domain-verify worker and the on-demand TLS `ask` gate.
 *
 * The lifecycle of a domain:
 *
 *   waiting_dns ──(public DNS points at a swarmy edge)──► verified
 *        ▲                                                  │ edge renders the site,
 *        │                                                  ▼ ACME runs
 *        └──(never verified)                     issuing ──► active
 *                                                   │
 *                                   error ◄─────────┘ (no trusted cert after the
 *                                                      grace window / expired /
 *                                                      DNS moved away)
 *
 * The GATE: a newly added auto-TLS host is not rendered (so Caddy never orders a
 * certificate, and the `ask` endpoint denies it) until DNS verifiably points at
 * us. Verification is sticky — once verified, a DNS blip reports `error` but
 * never un-renders a working site (that would drop its certificate).
 */
import { DOH_ANCHORS, LOCAL_RESOLVERS, canonicalResolverId, type DnsGateView, type ResolverState } from '@swarmy/core';
import { normalizeHostname, isWildcardHost } from './www';

// ───────────────────────────────────────────── state ──

export type DomainState = 'waiting_dns' | 'verified' | 'issuing' | 'active' | 'error';
export const DOMAIN_STATES: readonly DomainState[] = ['waiting_dns', 'verified', 'issuing', 'active', 'error'];

/** What one DNS check observed, reduced to the facts the UI and gate need. */
export interface DnsObservation {
  ok: boolean;
  /** Why it isn't pointing at us (null when ok). Plain words, user-facing. */
  reason: string | null;
  warnings: string[];
  a: string[];
  aaaa: string[];
  cname: string[];
  /** Which of the answers are swarmy edges. */
  matched: string[];
  /**
   * What each resolver swarmy asked answered, and whether it sees an edge —
   * the "what the world sees" view. Optional: records written before this
   * field existed don't carry it.
   */
  resolvers?: ResolverSeen[];
  /** The go-live gate as evaluated on this check (see {@link dnsGate}). Optional for old records. */
  gate?: DnsGateView;
}

/** One resolver's answer as kept on the observation (see `DnsObservation.resolvers`). */
export interface ResolverSeen {
  resolver: string;
  a: string[];
  aaaa: string[];
  cname: string[];
  nxdomain?: boolean;
  /** Transport / SERVFAIL error: this resolver told us nothing (and is ignored). */
  error?: string;
  /** It answered with at least one swarmy edge (or the tunnel CNAME). */
  matches: boolean;
  /** agrees / cached (an old or other answer) / no_answer (timeout) / error. Optional for old records. */
  state?: ResolverState;
  /** `local` = system resolver / swarmy-dns; `public` = DoH. Optional for old records. */
  tier?: 'local' | 'public';
}

/** What one certificate probe observed (TLS handshake against the edges). */
export interface CertObservation {
  /** A publicly-trusted certificate covering the host is being served. */
  ok: boolean;
  issuer: string | null;
  /** Epoch ms. */
  notAfter: number | null;
  error: string | null;
  /** Per edge probed: did it serve the trusted cert? */
  edges: Array<{ ip: string; ok: boolean; error?: string }>;
}

/**
 * Per-host record the controller persists (IngressConfig.settings
 * `domainChecks.hosts[host]`). Controller OBSERVATIONS of the outside world +
 * the onboarding gate — not swarm config, which is why it isn't a label.
 */
export interface DomainCheckRecord {
  host: string;
  addedAt: number;
  /** TLS/serving withheld until DNS is verified (only while !verifiedAt). */
  gated: boolean;
  verifiedAt?: number;
  /** An operator skipped the DNS check (behind a load balancer / external proxy). */
  verifiedManually?: boolean;
  lastCheckedAt?: number;
  nextCheckAt?: number;
  dns?: DnsObservation;
  cert?: CertObservation;
  certCheckedAt?: number;
}

export interface DomainChecks {
  hosts: Record<string, DomainCheckRecord>;
}

/** Coerce the persisted `settings.domainChecks` blob (tolerant — a bad blob reads as empty). */
export function domainChecksOf(settings: Record<string, unknown> | null | undefined): DomainChecks | undefined {
  const raw = settings?.domainChecks;
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as { hosts?: unknown };
  const hosts: Record<string, DomainCheckRecord> = {};
  if (r.hosts && typeof r.hosts === 'object') {
    for (const [host, rec] of Object.entries(r.hosts as Record<string, unknown>)) {
      if (rec && typeof rec === 'object' && typeof (rec as { addedAt?: unknown }).addedAt === 'number') {
        hosts[host] = { ...(rec as DomainCheckRecord), host };
      }
    }
  }
  return { hosts };
}

/** How long a verified domain may lack a trusted certificate before it is `error`. */
export const ISSUE_GRACE_MS = 10 * 60_000;
/** A record younger than this is never pruned (its route label may still be landing). */
export const PRUNE_GRACE_MS = 10 * 60_000;
/** Expiring this soon with no renewal is surfaced as a warning. */
export const EXPIRY_WARN_MS = 7 * 24 * 60 * 60_000;

/** Is `host` withheld from rendering / on-demand issuance right now? */
export function isHostGated(checks: DomainChecks | undefined, rawHost: string): boolean {
  if (!checks) return false;
  const host = normalizeHostname(rawHost);
  const rec = checks.hosts[host];
  // Only hosts swarmy registered through its own write paths (add domain, set
  // routes, www toggle, and every deploy path — compose, single service,
  // builder — for hosts no live route serves yet) are gated. A host the worker
  // merely DISCOVERS on a label (routed before this feature, or already live
  // when a redeploy re-declares it) is never withheld — un-rendering a domain
  // that already works would be an outage.
  return rec !== undefined && rec.gated && rec.verifiedAt === undefined;
}

/** A host's TLS posture, as far as the gate and state machine care. */
export interface HostPosture {
  host: string;
  tls: 'auto' | 'off' | 'custom';
  /** LAN / private-IP sslip names — served with Caddy's local CA, never ACME. */
  private: boolean;
  /** Served through a tunnel (Cloudflare terminates TLS; no ACME at our edge). */
  tunnel: boolean;
}

/** Does this host ever need an ACME order from our edge (and so the gate)? */
export function needsGate(p: HostPosture): boolean {
  return p.tls === 'auto' && !p.private && !p.tunnel;
}

/** A fresh record for a host swarmy starts routing (gated when it would hit ACME). */
export function newDomainRecord(p: HostPosture, now: number, grandfather = false): DomainCheckRecord {
  return { host: normalizeHostname(p.host), addedAt: now, gated: !grandfather && needsGate(p) };
}

export interface DomainStatus {
  state: DomainState;
  /** One plain-words sentence for the row. */
  reason: string;
  warnings: string[];
}

function fmtDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Derive the user-facing state from a record + the host's posture. Pure. */
export function domainState(rec: DomainCheckRecord | undefined, p: HostPosture, now: number): DomainStatus {
  const warnings = [...(rec?.dns?.warnings ?? [])];
  if (p.private) {
    return { state: 'active', reason: 'LAN-only name — served with swarmy’s local certificate authority (browsers will warn until they trust it).', warnings: [] };
  }
  if (!rec || rec.lastCheckedAt === undefined) {
    if (rec?.verifiedAt !== undefined) {
      return { state: 'verified', reason: 'DNS check skipped by an operator — waiting for the first certificate check.', warnings };
    }
    return { state: 'waiting_dns', reason: 'Checking DNS…', warnings };
  }
  const dnsOk = rec.dns?.ok ?? false;
  if (rec.verifiedAt === undefined) {
    return { state: 'waiting_dns', reason: rec.dns?.reason ?? 'DNS does not point at swarmy yet.', warnings };
  }
  if (!dnsOk && !rec.verifiedManually) {
    return {
      state: 'error',
      reason: `DNS no longer points at swarmy: ${rec.dns?.reason ?? 'lookup failed'}`,
      warnings,
    };
  }
  if (p.tls === 'off') return { state: 'active', reason: 'Serving over plain HTTP (TLS is off).', warnings };
  if (p.tunnel) return { state: 'active', reason: 'Served through Cloudflare Tunnel — Cloudflare holds the certificate.', warnings };
  const cert = rec.cert;
  if (!cert) {
    return { state: 'verified', reason: 'DNS verified — requesting a certificate.', warnings };
  }
  if (cert.ok && cert.notAfter !== null) {
    if (cert.notAfter <= now) {
      return { state: 'error', reason: `Certificate expired on ${fmtDate(cert.notAfter)} and was not renewed.`, warnings };
    }
    if (cert.notAfter - now < EXPIRY_WARN_MS) {
      warnings.push(`Certificate expires ${fmtDate(cert.notAfter)} and has not renewed yet.`);
    }
    const partial = cert.edges.filter((e) => !e.ok);
    if (partial.length > 0) {
      warnings.push(`${partial.length} of ${cert.edges.length} edges are not serving it yet (${partial.map((e) => e.ip).join(', ')}).`);
    }
    return {
      state: 'active',
      reason: `Secured${cert.issuer ? ` by ${cert.issuer}` : ''} until ${fmtDate(cert.notAfter)}.`,
      warnings,
    };
  }
  if (p.tls === 'custom') {
    return { state: 'error', reason: cert.error ?? 'The custom certificate is not being served.', warnings };
  }
  if (now - rec.verifiedAt > ISSUE_GRACE_MS) {
    return {
      state: 'error',
      reason: `No trusted certificate ${Math.round((now - rec.verifiedAt) / 60_000)} min after DNS verified: ${cert.error ?? 'issuance has not succeeded'}.`,
      warnings,
    };
  }
  return { state: 'issuing', reason: 'Requesting a certificate from Let’s Encrypt…', warnings };
}

// ───────────────────────────────────────────── scheduling ──

/** When should `rec` next be checked? Fast while waiting, slow once settled. */
export function nextCheckDelay(rec: DomainCheckRecord, now: number): number {
  if (rec.verifiedAt === undefined) {
    const age = now - rec.addedAt;
    if (age < 10 * 60_000) return 30_000;
    if (age < 60 * 60_000) return 2 * 60_000;
    if (age < 24 * 60 * 60_000) return 10 * 60_000;
    return 60 * 60_000;
  }
  if (!rec.cert?.ok) return 60_000; // issuing: watch it land
  return 10 * 60_000;
}

export interface DomainCheckPlan {
  /** Hosts to check this tick (due, capped). */
  check: string[];
  /** New records to create (first sight of a host). */
  create: DomainCheckRecord[];
  /** Records whose host is no longer routed. */
  prune: string[];
}

/**
 * Plan one worker tick for an org: which hosts to (re)check, which records to
 * create for newly-seen hosts, and which to prune. Private hosts are never
 * checked (no public DNS to ask). Deterministic (sorted, capped at `max`).
 */
export function planDomainChecks(input: {
  hosts: readonly HostPosture[];
  checks: DomainChecks | undefined;
  now: number;
  max?: number;
}): DomainCheckPlan {
  const { now } = input;
  const max = input.max ?? 20;
  const existing = input.checks?.hosts ?? {};
  const live = new Map<string, HostPosture>();
  for (const p of input.hosts) live.set(normalizeHostname(p.host), p);

  const create: DomainCheckRecord[] = [];
  const due: Array<{ host: string; at: number }> = [];
  for (const [host, p] of [...live.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (p.private) continue;
    const rec = existing[host];
    if (!rec) {
      // Discovered, not registered: observed but never gated (see isHostGated).
      create.push(newDomainRecord(p, now, true));
      due.push({ host, at: 0 });
      continue;
    }
    const at = rec.nextCheckAt ?? 0;
    if (at <= now) due.push({ host, at });
  }
  due.sort((a, b) => a.at - b.at || (a.host < b.host ? -1 : 1));
  // A just-registered host may not be on the live labels yet (the label write
  // is in flight) — never prune a young record, or it would come back as an
  // ungated "discovered" one.
  const prune = Object.keys(existing)
    .filter((h) => !live.has(h) && now - (existing[h]!.addedAt ?? 0) > PRUNE_GRACE_MS)
    .sort();
  return { check: due.slice(0, max).map((d) => d.host), create, prune };
}

/**
 * Fold one check's observations into a record. Verification is sticky:
 * `verifiedAt` is set the first time DNS points at us and never cleared.
 */
export function applyCheck(
  rec: DomainCheckRecord,
  obs: { dns?: DnsObservation; cert?: CertObservation },
  now: number,
): DomainCheckRecord {
  const next: DomainCheckRecord = { ...rec, lastCheckedAt: now };
  if (obs.dns) next.dns = obs.dns;
  if (obs.cert) {
    next.cert = obs.cert;
    next.certCheckedAt = now;
  }
  if (next.verifiedAt === undefined && obs.dns?.ok) next.verifiedAt = now;
  next.nextCheckAt = now + nextCheckDelay(next, now);
  return next;
}

/** Did the check flip a host from gated to renderable? (→ re-render the edge now.) */
export function becameRenderable(before: DomainCheckRecord | undefined, after: DomainCheckRecord): boolean {
  return (before?.verifiedAt === undefined) && after.verifiedAt !== undefined && (before?.gated ?? true);
}

/**
 * The material part of a record — what changes the UI or the render. The
 * worker writes the store only when this changes (or a check was due), so a
 * steady state does not rewrite settings every tick.
 */
export function recordSignature(rec: DomainCheckRecord): string {
  return JSON.stringify([
    rec.gated,
    rec.verifiedAt ?? null,
    rec.dns?.ok ?? null,
    rec.dns?.reason ?? null,
    rec.dns?.warnings ?? [],
    rec.dns?.gate ? [rec.dns.gate.agreeing, rec.dns.gate.answering] : null,
    rec.cert?.ok ?? null,
    rec.cert?.notAfter ?? null,
    rec.cert?.error ?? null,
  ]);
}

// ───────────────────────────────────────────── DNS evaluation ──

/** One resolver's answer set for a name (A + AAAA lookups, CNAME chain merged). */
export interface ResolverAnswer {
  resolver: string;
  a: string[];
  aaaa: string[];
  cname: string[];
  nxdomain?: boolean;
  /** Transport / SERVFAIL error — this resolver told us nothing. */
  error?: string;
}

/**
 * Parse a DNS-over-HTTPS JSON response (RFC 8427-ish, the format both
 * `cloudflare-dns.com/dns-query` and `dns.google/resolve` return) into an
 * answer set. Tolerant: garbage in → an `error` answer, never a throw.
 */
export function parseDohJson(json: unknown, resolver: string): ResolverAnswer {
  const out: ResolverAnswer = { resolver, a: [], aaaa: [], cname: [] };
  if (!json || typeof json !== 'object') return { ...out, error: 'malformed DNS response' };
  const j = json as { Status?: unknown; Answer?: unknown };
  const status = typeof j.Status === 'number' ? j.Status : -1;
  if (status === 3) return { ...out, nxdomain: true };
  if (status !== 0) return { ...out, error: status === 2 ? 'SERVFAIL' : `DNS status ${status}` };
  if (Array.isArray(j.Answer)) {
    for (const ans of j.Answer) {
      if (!ans || typeof ans !== 'object') continue;
      const { type, data } = ans as { type?: unknown; data?: unknown };
      if (typeof data !== 'string') continue;
      const value = data.trim().replace(/\.$/, '').toLowerCase();
      if (type === 1) out.a.push(value);
      else if (type === 28) out.aaaa.push(value);
      else if (type === 5) out.cname.push(value);
    }
  }
  return out;
}

/** Merge several per-type answers from ONE resolver (A query + AAAA query). */
export function mergeAnswers(resolver: string, parts: readonly ResolverAnswer[]): ResolverAnswer {
  const errors = parts.filter((p) => p.error);
  if (errors.length === parts.length && parts.length > 0) {
    return { resolver, a: [], aaaa: [], cname: [], error: errors[0]!.error };
  }
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  return {
    resolver,
    a: uniq(parts.flatMap((p) => p.a)),
    aaaa: uniq(parts.flatMap((p) => p.aaaa)),
    cname: uniq(parts.flatMap((p) => p.cname)),
    nxdomain: parts.length > 0 && parts.every((p) => p.nxdomain || p.error) && parts.some((p) => p.nxdomain),
  };
}

/** Cloudflare's published proxy ranges (IPv4) — an orange-cloud record resolves here. */
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
];

function v4ToInt(ip: string): number | null {
  const m = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

export function isCloudflareProxyIp(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n !== null) {
    return CLOUDFLARE_V4.some((cidr) => {
      const [base, bits] = cidr.split('/') as [string, string];
      const b = v4ToInt(base)!;
      const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
      return ((n & mask) >>> 0) === ((b & mask) >>> 0);
    });
  }
  const v6 = ip.toLowerCase();
  return ['2400:cb00:', '2606:4700:', '2803:f800:', '2405:b500:', '2405:8100:', '2a06:98c0:', '2c0f:f248:'].some((p) =>
    v6.startsWith(p),
  );
}

export function isIpv6(ip: string): boolean {
  return ip.includes(':');
}

/** Canonical form for comparing IPv6 literals (expand `::`, drop leading zeros). */
function canonIp(ip: string): string {
  const s = ip.trim().toLowerCase();
  if (!isIpv6(s)) return s;
  const [head, tail] = s.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail.length > 0 ? tail.split(':') : [];
  const fill = tail !== undefined ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((g) => g.replace(/^0+(?=.)/, '')).join(':');
}

/** What "pointing at us" means for this org right now. */
export interface ExpectedTarget {
  /** Public IPs of the edges that terminate this org's traffic. */
  ips: string[];
  /** Cloudflare Tunnel: the CNAME target (`<id>.cfargotunnel.com`). */
  tunnelCname?: string | null;
}

/** The name to look up for `host` (wildcards: a probe label under the base). */
export function lookupNameFor(host: string): string {
  const h = normalizeHostname(host);
  return isWildcardHost(h) ? `swarmy-dns-check.${h.slice(2)}` : h;
}

/** Is this resolver asked from inside the cluster (system resolver / swarmy-dns)? */
export function isLocalResolver(id: string): boolean {
  return LOCAL_RESOLVERS.includes(id);
}

/** A resolver that errored: unreachable / timed out (`no_answer`) vs answered with an error (`error`). */
export function silentState(error: string): 'no_answer' | 'error' {
  return /time|abort|fetch failed|unable to connect|network|ECONN|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket/i.test(error)
    ? 'no_answer'
    : 'error';
}

/** Share of answering public resolvers that must agree: 3 of every 4. */
export const GATE_NUMERATOR = 3;
export const GATE_DENOMINATOR = 4;

/** How many of `answering` resolvers must agree (⌈3n/4⌉). */
export function gateNeeded(answering: number): number {
  return Math.ceil((answering * GATE_NUMERATOR) / GATE_DENOMINATOR);
}

/**
 * THE GO-LIVE GATE (owner decision Q13) over one check's per-resolver results.
 *
 * - Public DoH resolvers that answered vote: at least 3 of every 4 must point at
 *   our edges, AND 1.1.1.1 and 8.8.8.8 must be among the agreeing ones.
 * - The anchor clause covers only the anchors that are CONFIGURED (present in
 *   the list) — a custom `SWARMY_DOH_RESOLVERS` without cloudflare/google is
 *   gated on 3-in-4 alone — and, like every resolver, an anchor that did not
 *   answer (timeout / error) is left out rather than blocking, so a network
 *   that can't reach dns.google still works.
 * - Resolvers still returning another answer are "still cached": they count in
 *   the denominator but never block on their own.
 * - No public resolver answered (air-gapped / no egress): the local tier (the
 *   controller's own resolver + swarmy-dns) decides, and every local resolver
 *   that answered must agree — the pre-Q13 rule.
 */
export function dnsGate(resolvers: readonly Pick<ResolverSeen, 'resolver' | 'matches' | 'error' | 'tier'>[]): DnsGateView {
  const pub = resolvers.filter((r) => r.tier !== 'local');
  const anchorIds = [...new Set(pub.map((r) => canonicalResolverId(r.resolver)).filter((id) => id in DOH_ANCHORS))];
  const anchors = Object.keys(DOH_ANCHORS)
    .filter((id) => anchorIds.includes(id))
    .map((id) => DOH_ANCHORS[id]!);
  const pubAnswered = pub.filter((r) => !r.error);
  if (pubAnswered.length > 0) {
    const agreeing = pubAnswered.filter((r) => r.matches).length;
    const needed = gateNeeded(pubAnswered.length);
    const anchorsAgree = pubAnswered
      .filter((r) => canonicalResolverId(r.resolver) in DOH_ANCHORS)
      .every((r) => r.matches);
    return { basis: 'public', agreeing, answering: pubAnswered.length, needed, anchors, anchorsAgree, pass: agreeing >= needed && anchorsAgree };
  }
  const local = resolvers.filter((r) => r.tier === 'local' && !r.error);
  if (local.length === 0) {
    return { basis: 'none', agreeing: 0, answering: 0, needed: 0, anchors, anchorsAgree: true, pass: false };
  }
  const agreeing = local.filter((r) => r.matches).length;
  return {
    basis: 'local',
    agreeing,
    answering: local.length,
    needed: local.length,
    anchors,
    anchorsAgree: true,
    pass: agreeing === local.length,
  };
}

/** "9 of 12 resolvers see your edges; swarmy needs 9, including 1.1.1.1 and 8.8.8.8" — the gate in words. */
function gateShortfall(gate: DnsGateView, voters: readonly ResolverSeen[]): string {
  const ipsOf = (x: ResolverSeen) => [...x.a, ...x.aaaa].join(', ') || (x.nxdomain ? 'no record' : 'nothing');
  const anchorsBehind = voters.filter((x) => !x.matches && canonicalResolverId(x.resolver) in DOH_ANCHORS);
  const incl = gate.anchors.length ? `, including ${gate.anchors.join(' and ')}` : '';
  const lag = anchorsBehind.length
    ? ` ${anchorsBehind.map((x) => `${DOH_ANCHORS[canonicalResolverId(x.resolver)]} still sees ${ipsOf(x)}`).join('; ')}.`
    : '';
  return `Still propagating: ${gate.agreeing} of ${gate.answering} resolvers see a swarmy edge; swarmy needs ${gate.needed}${incl}.${lag}`;
}

/**
 * Decide whether public DNS points `host` at a swarmy edge, by the go-live
 * gate ({@link dnsGate}): 3 of every 4 public resolvers that answered, with
 * 1.1.1.1 and 8.8.8.8 among them; the local tier only when no public resolver
 * answered. Resolvers holding an old answer are "still cached" — they show on
 * the map and don't block. A foreign AAAA (seen by an agreeing resolver) with
 * no IPv6 edge match BLOCKS: Let's Encrypt prefers IPv6, so validation would
 * land elsewhere.
 */
export function evaluateDns(host: string, answers: readonly ResolverAnswer[], expected: ExpectedTarget): DnsObservation {
  const answered = answers.filter((a) => !a.error);
  const a = [...new Set(answered.flatMap((x) => x.a))].sort();
  const aaaa = [...new Set(answered.flatMap((x) => x.aaaa))].sort();
  const cname = [...new Set(answered.flatMap((x) => x.cname))].sort();
  const edgeSet = new Set(expected.ips.map(canonIp));
  const tunnel = expected.tunnelCname?.toLowerCase() ?? null;
  const resolvers: ResolverSeen[] = answers.map((x) => {
    const matches =
      !x.error &&
      ([...x.a, ...x.aaaa].some((ip) => edgeSet.has(canonIp(ip))) ||
        (tunnel !== null && (x.cname.includes(tunnel) || (x.a.length > 0 && x.a.every(isCloudflareProxyIp)))));
    return {
      resolver: x.resolver,
      a: x.a,
      aaaa: x.aaaa,
      cname: x.cname,
      ...(x.nxdomain ? { nxdomain: true } : {}),
      ...(x.error ? { error: x.error } : {}),
      matches,
      state: x.error ? silentState(x.error) : matches ? 'agrees' : 'cached',
      tier: isLocalResolver(x.resolver) ? 'local' : 'public',
    };
  });
  const gate = dnsGate(resolvers);
  const base = { a, aaaa, cname, warnings: [] as string[], matched: [] as string[], resolvers, gate };
  const fail = (reason: string, warnings: string[] = []): DnsObservation => ({ ...base, ok: false, reason, warnings });

  if (answered.length === 0) {
    return fail(`DNS lookup failed (${answers.map((x) => `${x.resolver}: ${x.error ?? 'no answer'}`).join('; ') || 'no resolvers'}).`);
  }

  if (expected.tunnelCname) {
    const target = expected.tunnelCname.toLowerCase();
    const viaCname = cname.includes(target);
    const proxied = a.length > 0 && a.every(isCloudflareProxyIp);
    if (viaCname || proxied) return { ...base, ok: true, reason: null, matched: viaCname ? [target] : a };
    if (a.length === 0 && aaaa.length === 0) return fail(`No DNS record for ${host} yet — add the CNAME to ${target}.`);
    return fail(`${host} points at ${[...a, ...aaaa].join(', ')}, not the Cloudflare Tunnel (${target}).`);
  }

  // The resolvers whose answers decide: the public ones that answered, or the
  // local tier when none did.
  const voters = resolvers.filter((r) => !r.error && (gate.basis === 'public' ? r.tier === 'public' : r.tier === 'local'));
  const va = [...new Set(voters.flatMap((x) => x.a))].sort();
  const vaaaa = [...new Set(voters.flatMap((x) => x.aaaa))].sort();
  const vcname = [...new Set(voters.flatMap((x) => x.cname))].sort();

  if (va.length === 0 && vaaaa.length === 0) {
    return fail(
      voters.every((x) => x.nxdomain)
        ? `No DNS record for ${host} yet.`
        : `${host} exists but has no A/AAAA record${vcname.length ? ` (CNAME → ${vcname.join(', ')} resolves to nothing)` : ''}.`,
    );
  }
  if (expected.ips.length === 0) {
    return fail('No ingress node has a known public IP yet, so there is nothing to compare DNS against.');
  }
  const isOurs = (ip: string) => edgeSet.has(canonIp(ip));
  const all = [...va, ...vaaaa];
  const matched = all.filter(isOurs);
  if (matched.length === 0) {
    if (all.every(isCloudflareProxyIp)) {
      return fail(
        `${host} resolves to Cloudflare’s proxy (${all.join(', ')}). Set the record to “DNS only” (grey cloud) so swarmy can get a certificate, or use the Cloudflare Tunnel driver.`,
      );
    }
    return fail(`${host} points at ${all.join(', ')} — expected ${expected.ips.join(' or ')}.`);
  }
  if (!gate.pass) {
    return { ...base, matched, ok: false, reason: gateShortfall(gate, voters) };
  }
  // Stale-record checks look only at what the AGREEING resolvers answered —
  // another resolver's old answer is a cache, not a record to remove.
  const agreeing = voters.filter((x) => x.matches);
  const foreignA = [...new Set(agreeing.flatMap((x) => x.a))].filter((ip) => !isOurs(ip)).sort();
  const agreeingAaaa = [...new Set(agreeing.flatMap((x) => x.aaaa))];
  const foreignAaaa = agreeingAaaa.filter((ip) => !isOurs(ip)).sort();
  const v6Matched = agreeingAaaa.some(isOurs);
  if (foreignAaaa.length > 0 && !v6Matched) {
    return {
      ...base,
      matched,
      ok: false,
      reason: `An AAAA record points ${host} at ${foreignAaaa.join(', ')}. Let’s Encrypt tries IPv6 first, so remove it (or point it at a swarmy edge).`,
    };
  }
  const warnings: string[] = [];
  if (foreignA.length > 0 || foreignAaaa.length > 0) {
    warnings.push(
      `${host} also points at ${[...foreignA, ...foreignAaaa].join(', ')}, which is not a swarmy edge — some visitors will land there. Remove the stale record.`,
    );
  }
  return { ...base, matched, ok: true, reason: null, warnings };
}

// ───────────────────────────────────────────── guidance ──

export interface DnsRecordHint {
  type: 'A' | 'AAAA' | 'CNAME' | 'NS';
  /** Fully-qualified record name. */
  name: string;
  /** What most registrar UIs want in the "host" box (`@`, `www`, `app`). */
  label: string;
  value: string;
  note?: string;
}

export interface DnsGuidance {
  /**
   * `records` — create these at your DNS provider; `zone` — the host is inside a
   * zone swarmy serves (delegate NS once, then it is automatic); `tunnel` —
   * a proxied CNAME to the Cloudflare Tunnel; `private` — a LAN name.
   */
  mode: 'records' | 'zone' | 'tunnel' | 'private';
  summary: string;
  records: DnsRecordHint[];
  /** Equivalent alternative (e.g. CNAME instead of A) — pick one set. */
  alternatives: DnsRecordHint[];
  /**
   * Wildcards only: how the certificate is issued (ACME DNS-01). `swarmy` =
   * swarmy's own nameservers publish the challenge; `cloudflare` = the BYO
   * provider token; null = nobody can yet (the summary says how to fix it).
   */
  wildcard?: { provider: 'swarmy' | 'cloudflare' | null; summary: string };
}

/** Common two-label public suffixes, so `shop.co.uk` reads as an apex. */
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'me.uk', 'ac.uk', 'co.za', 'org.za', 'com.au', 'net.au', 'org.au',
  'co.nz', 'org.nz', 'com.br', 'co.jp', 'co.in', 'com.mx', 'com.sg', 'com.tr', 'co.kr',
]);

/** Best-effort registrable apex of `host` (no PSL — a short suffix list). */
export function apexOf(host: string): string {
  const labels = normalizeHostname(host).replace(/^\*\./, '').split('.');
  const lastTwo = labels.slice(-2).join('.');
  const n = TWO_LABEL_SUFFIXES.has(lastTwo) ? 3 : 2;
  return labels.slice(-n).join('.');
}

export function isApex(host: string): boolean {
  return normalizeHostname(host) === apexOf(host);
}

function labelFor(name: string, zone: string): string {
  if (name === zone) return '@';
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

export interface GuidanceInput {
  host: string;
  expected: ExpectedTarget;
  /** A stable swarmy hostname that already resolves to the edge (CNAME alternative). */
  cnameTarget?: string | null;
  /** A swarmy-served zone containing the host, when there is one. */
  zone?: { zone: string; delegated?: boolean; nameservers: Array<{ fqdn: string; ip: string }> } | null;
  private?: boolean;
  /** Wildcards: who solves the DNS-01 challenge (see `planDnsChallenges`). */
  dnsChallenge?: 'swarmy' | 'cloudflare' | null;
}

function wildcardNote(host: string, input: GuidanceInput): DnsGuidance['wildcard'] {
  if (!isWildcardHost(host)) return undefined;
  const base = host.slice(2);
  const provider = input.dnsChallenge ?? null;
  if (provider === 'swarmy') {
    return {
      provider,
      summary: `The wildcard certificate is issued over ACME DNS-01 by swarmy’s own nameservers (they publish _acme-challenge.${base} themselves) — no DNS provider account or API token involved. It is requested once ${input.zone?.zone ?? 'the zone'} is delegated to swarmy.`,
    };
  }
  if (provider) {
    return {
      provider,
      summary: `The wildcard certificate is issued over ACME DNS-01 through your ${provider} API token (the zone is not served by swarmy).`,
    };
  }
  return {
    provider: null,
    summary: `A wildcard certificate can only be issued over ACME DNS-01. Recommended: add ${apexOf(host)} (or ${base}) as a zone in swarmy DNS and point its NS records at swarmy’s nameservers — swarmy then answers the challenge itself. Otherwise add a DNS provider API token under Edge & ingress → Wildcard certificates.`,
  };
}

/** Exactly which records to create for `host` (+ the wildcard DNS-01 note). Pure. */
export function dnsGuidance(input: GuidanceInput): DnsGuidance {
  const out = recordGuidance(input);
  const wildcard = wildcardNote(normalizeHostname(input.host), input);
  return wildcard ? { ...out, wildcard } : out;
}

function recordGuidance(input: GuidanceInput): DnsGuidance {
  const host = normalizeHostname(input.host);
  const apex = apexOf(host);
  if (input.private) {
    return {
      mode: 'private',
      summary: `${host} is a LAN-only name: point your local DNS (or hosts file) at an ingress node’s LAN address. It is served with swarmy’s local certificate authority.`,
      records: [],
      alternatives: [],
    };
  }
  if (input.expected.tunnelCname) {
    return {
      mode: 'tunnel',
      summary: `Create a proxied CNAME for ${host} pointing at the Cloudflare Tunnel. swarmy upserts it automatically when the zone is on Cloudflare.`,
      records: [
        { type: 'CNAME', name: host, label: labelFor(host, apex), value: input.expected.tunnelCname, note: 'Proxied (orange cloud).' },
      ],
      alternatives: [],
    };
  }
  if (input.zone) {
    const z = input.zone;
    return {
      mode: 'zone',
      summary: z.delegated
        ? `${z.zone} is served by swarmy’s nameservers — ${host} resolves to the nearest edge automatically.`
        : `${host} is inside ${z.zone}, which swarmy serves. Point ${z.zone}’s nameservers at swarmy once (with glue records) and every host in it resolves automatically.`,
      records: z.nameservers.map((ns) => ({ type: 'NS' as const, name: z.zone, label: '@', value: ns.fqdn, note: `Glue: ${ns.fqdn} → ${ns.ip}` })),
      alternatives: [],
    };
  }
  const ips = [...new Set(input.expected.ips)].sort((x, y) => Number(isIpv6(x)) - Number(isIpv6(y)) || (x < y ? -1 : x > y ? 1 : 0));
  const name = host;
  const label = labelFor(name, apex);
  const records: DnsRecordHint[] = ips.map((ip) => ({
    type: isIpv6(ip) ? ('AAAA' as const) : ('A' as const),
    name,
    label,
    value: ip,
  }));
  const alternatives: DnsRecordHint[] = [];
  const target = input.cnameTarget ? normalizeHostname(input.cnameTarget) : null;
  if (target && !isApex(host) && target !== host) {
    alternatives.push({
      type: 'CNAME',
      name,
      label,
      value: target,
      note: 'Follows the edge if its IPs change. Not allowed at the apex.',
    });
  }
  const multi = ips.length > 1 ? ' Add one record per address — visitors are spread across the edges.' : '';
  return {
    mode: 'records',
    summary:
      ips.length === 0
        ? 'No ingress node has a known public IP yet — mark a node as ingress (or set its public-IP override) and the records appear here.'
        : `At your DNS provider, point ${host} at swarmy’s edge.${multi} Remove any other A/AAAA records for this name.`,
    records,
    alternatives,
  };
}

// ───────────────────────────────────────────── certificates ──

/** Raw result of one TLS handshake (controller-side `tls.connect`). */
export interface TlsProbe {
  ip: string;
  /** Handshake/transport failure — no certificate at all. */
  error?: string;
  /** Chain validates against the public roots (`socket.authorized`). */
  authorized?: boolean;
  authorizationError?: string | null;
  issuerOrg?: string | null;
  issuerCn?: string | null;
  /** `valid_to` as returned by node (e.g. `Dec 22 12:00:00 2026 GMT`). */
  validTo?: string | null;
  /** `subjectaltname` as returned by node (`DNS:a.com, DNS:www.a.com`). */
  subjectAltName?: string | null;
}

/** Does a certificate's SAN list cover `host` (one-level wildcard rules)? */
export function certCoversHost(subjectAltName: string | null | undefined, rawHost: string): boolean {
  if (!subjectAltName) return false;
  const host = normalizeHostname(rawHost);
  const names = subjectAltName
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase());
  return names.some((n) => {
    if (n === host) return true;
    if (n.startsWith('*.')) {
      const suffix = n.slice(1); // ".acme.com"
      if (!host.endsWith(suffix)) return false;
      const left = host.slice(0, -suffix.length);
      return left.length > 0 && !left.includes('.');
    }
    return false;
  });
}

function probeError(p: TlsProbe, host: string): string | null {
  if (p.error) {
    if (/alert|internal error|handshake/i.test(p.error)) return 'the edge has no certificate for this name yet';
    return p.error;
  }
  if (!certCoversHost(p.subjectAltName, host)) return 'the edge is serving a certificate for a different name';
  if (!p.authorized) {
    const e = p.authorizationError ?? 'untrusted';
    if (/SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY/i.test(e)) {
      return 'the edge is serving a temporary/self-signed certificate (a public one has not been issued yet)';
    }
    if (/EXPIRED/i.test(e)) return 'the served certificate has expired';
    return `the served certificate is not trusted (${e})`;
  }
  return null;
}

/** Reduce per-edge handshakes into one certificate observation. Pure. */
export function certFromProbes(host: string, probes: readonly TlsProbe[]): CertObservation {
  const edges = probes.map((p) => {
    const err = probeError(p, host);
    return err ? { ip: p.ip, ok: false, error: err } : { ip: p.ip, ok: true };
  });
  const good = probes.filter((p, i) => edges[i]!.ok);
  if (good.length === 0) {
    return {
      ok: false,
      issuer: null,
      notAfter: null,
      error: edges[0]?.error ?? 'no edge to probe',
      edges,
    };
  }
  const best = good[0]!;
  const notAfter = best.validTo ? Date.parse(best.validTo) : NaN;
  return {
    ok: true,
    issuer: best.issuerOrg ?? best.issuerCn ?? null,
    notAfter: Number.isFinite(notAfter) ? notAfter : null,
    error: null,
    edges,
  };
}

// ───────────────────────────────────────────── alerts ──

/** Default `cert-expiry` threshold (the seeded rule's). */
export const CERT_EXPIRY_ALERT_MS = 14 * 24 * 60 * 60_000;
const CRITICAL_MS = 3 * 24 * 60 * 60_000;

export interface CertAlert {
  status: 'firing' | 'resolved';
  severity: 'warning' | 'critical';
  message: string;
}

/**
 * The `cert-expiry` alert a check implies for one host, or null when there is
 * nothing to say (not verified yet, still inside the issuing grace window,
 * tunnel/private/plain-HTTP hosts). Pure — the service fires it.
 */
export function certAlertFor(
  rec: DomainCheckRecord | undefined,
  p: HostPosture,
  now: number,
  thresholdMs = CERT_EXPIRY_ALERT_MS,
): CertAlert | null {
  if (!rec?.cert || rec.verifiedAt === undefined || p.private || p.tunnel || p.tls === 'off') return null;
  const c = rec.cert;
  if (c.ok && c.notAfter !== null) {
    const left = c.notAfter - now;
    if (left <= 0) {
      return { status: 'firing', severity: 'critical', message: `Certificate for ${rec.host} expired on ${fmtDate(c.notAfter)} and was not renewed.` };
    }
    if (left < thresholdMs) {
      const days = Math.max(0, Math.floor(left / 86_400_000));
      return {
        status: 'firing',
        severity: left < CRITICAL_MS ? 'critical' : 'warning',
        message: `Certificate for ${rec.host} expires ${fmtDate(c.notAfter)} (${days} day${days === 1 ? '' : 's'}) and has not renewed yet.`,
      };
    }
    return { status: 'resolved', severity: 'warning', message: `Certificate for ${rec.host} is valid until ${fmtDate(c.notAfter)}.` };
  }
  const s = domainState(rec, p, now);
  if (s.state === 'error') {
    return { status: 'firing', severity: 'critical', message: `Certificate for ${rec.host} is failing: ${c.error ?? s.reason}` };
  }
  return null;
}
