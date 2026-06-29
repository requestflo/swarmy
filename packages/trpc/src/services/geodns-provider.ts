/**
 * GeoDNS provider sync (epic #12, Part A — PHASE 3).
 *
 * swarmy can run GSLB self-hosted (CoreDNS) AND/OR mirror the live zone into a
 * managed DNS provider. This module is the provider seam: given a health-filtered
 * zone snapshot, an adapter reconciles the provider's A/CNAME records (and, where
 * the provider supports it natively, latency/geo routing) to match.
 *
 * Design notes:
 *  - Pure where it can be: {@link diffRecords} computes create/update/delete with
 *    no IO, so it is unit-tested directly.
 *  - The HTTP client is injected (`opts.fetchImpl`, default global fetch) so the
 *    adapters are testable without network and never reach out during typecheck.
 *  - Secrets stay out of the DB: the caller resolves the API token from the
 *    controller's secret-injected environment (or a Docker secret) and passes it
 *    in as `opts.token`. This module never reads or persists the raw value.
 *  - Cloudflare: token = an API token (Bearer). DNS round-robin via multiple A
 *    records; true geo steering there needs Cloudflare Load Balancing (account
 *    scope) and is out of scope for token-only sync — we tag each record so the
 *    mapping is auditable and fall back to multi-answer round-robin.
 *  - Route53: token = "accessKeyId:secretAccessKey[:sessionToken]". Latency-based
 *    routing is native (one RRSet per region with SetIdentifier + Region), so the
 *    adapter emits latency records when a host spans multiple regions.
 */
import { createHash, createHmac } from 'node:crypto';

// ───────────────────────────────────────────── public types ──

export type ProviderName = 'cloudflare' | 'route53';

/** One desired endpoint in the (already health-filtered) zone. */
export interface ProviderEndpoint {
  /** Fully-qualified host, e.g. `app.geo.example.com`. */
  host: string;
  /** `swarmy.region` label this endpoint lives in. */
  region: string;
  /** A-record IP or CNAME hostname. */
  target: string;
  /** Live health bit (persisted AND online), already composed by the caller. */
  healthy: boolean;
}

export interface ProviderZoneSnapshot {
  zone: string;
  ttl: number;
  endpoints: ProviderEndpoint[];
}

export interface ProviderSyncOptions {
  /** Cloudflare zone id / Route53 hosted-zone id. */
  zoneId: string;
  /** API token (Cloudflare) or `accessKeyId:secretAccessKey[:sessionToken]` (Route53). */
  token: string;
  /** Route53 signing region (default us-east-1). Ignored by Cloudflare. */
  region?: string;
  /** Injected fetch (default: global fetch). */
  fetchImpl?: typeof fetch;
  /** Compute the change set but do not call the provider. */
  dryRun?: boolean;
}

export type ChangeOp = 'create' | 'update' | 'delete';

export interface RecordChange {
  op: ChangeOp;
  host: string;
  type: 'A' | 'CNAME';
  value: string;
  /** region tag / set-identifier for auditing the steering decision. */
  region?: string;
  detail?: string;
}

export interface ProviderSyncResult {
  provider: ProviderName;
  /** Changes computed from the diff. */
  planned: RecordChange[];
  /** Changes actually applied (== planned unless dryRun or a call failed). */
  applied: number;
  /** Non-fatal errors encountered while applying individual changes. */
  errors: string[];
}

export interface DnsProvider {
  readonly name: ProviderName;
  syncZone(snapshot: ProviderZoneSnapshot, opts: ProviderSyncOptions): Promise<ProviderSyncResult>;
}

// ───────────────────────────────────────────── desired set (pure) ──

const isIp = (s: string): boolean => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);

/** A desired record after health filtering + failover spill. */
export interface DesiredRecord {
  host: string;
  type: 'A' | 'CNAME';
  value: string;
  region: string;
}

/**
 * The records the provider SHOULD hold: per host, the healthy endpoints (or, if
 * none are healthy, all of them — spill, never NXDOMAIN), as A (IP) or CNAME.
 * Deterministically ordered so diffs are stable.
 */
export function desiredRecords(snapshot: ProviderZoneSnapshot): DesiredRecord[] {
  const byHost = new Map<string, ProviderEndpoint[]>();
  for (const e of snapshot.endpoints) {
    const list = byHost.get(e.host) ?? [];
    list.push(e);
    byHost.set(e.host, list);
  }
  const out: DesiredRecord[] = [];
  for (const [host, eps] of [...byHost.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const healthy = eps.filter((e) => e.healthy);
    const pool = healthy.length > 0 ? healthy : eps;
    for (const e of pool) {
      out.push({
        host,
        type: isIp(e.target) ? 'A' : 'CNAME',
        value: e.target,
        region: e.region,
      });
    }
  }
  return out.sort((a, b) =>
    a.host !== b.host
      ? a.host < b.host
        ? -1
        : 1
      : a.value < b.value
        ? -1
        : a.value > b.value
          ? 1
          : 0,
  );
}

/** An existing provider record, normalised across providers for diffing. */
export interface ExistingRecord {
  /** Provider-native id (Cloudflare record id / Route53 SetIdentifier|name). */
  id: string;
  host: string;
  type: string;
  value: string;
  ttl?: number;
  /** True when swarmy created/owns this record (so we may delete it). */
  managed: boolean;
}

export interface RecordDiff {
  create: DesiredRecord[];
  /** Existing records to delete (managed, no longer desired). */
  delete: ExistingRecord[];
  /** Desired records that already exist (id carried for ttl/update). */
  keep: Array<{ desired: DesiredRecord; existing: ExistingRecord }>;
}

const key = (host: string, type: string, value: string): string =>
  `${host.toLowerCase()}|${type.toUpperCase()}|${value.toLowerCase()}`;

/** Pure reconcile: what to create, delete, and keep. Identity = host+type+value. */
export function diffRecords(desired: DesiredRecord[], existing: ExistingRecord[]): RecordDiff {
  const existingByKey = new Map<string, ExistingRecord>();
  for (const e of existing) existingByKey.set(key(e.host, e.type, e.value), e);
  const desiredKeys = new Set(desired.map((d) => key(d.host, d.type, d.value)));

  const create: DesiredRecord[] = [];
  const keep: RecordDiff['keep'] = [];
  for (const d of desired) {
    const match = existingByKey.get(key(d.host, d.type, d.value));
    if (match) keep.push({ desired: d, existing: match });
    else create.push(d);
  }
  const del = existing.filter((e) => e.managed && !desiredKeys.has(key(e.host, e.type, e.value)));
  return { create, delete: del, keep };
}

// ───────────────────────────────────────────── Cloudflare ──

const CF_API = 'https://api.cloudflare.com/client/v4';
const CF_TAG = 'swarmy:gslb';

interface CfRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  comment?: string | null;
}

async function cfList(
  zoneId: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<ExistingRecord[]> {
  const out: ExistingRecord[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetchImpl(
      `${CF_API}/zones/${zoneId}/dns_records?per_page=100&page=${page}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    if (!res.ok) throw new Error(`cloudflare list ${res.status}`);
    const body = (await res.json()) as {
      result?: CfRecord[];
      result_info?: { total_pages?: number };
    };
    for (const r of body.result ?? []) {
      if (r.type !== 'A' && r.type !== 'CNAME') continue;
      out.push({
        id: r.id,
        host: r.name,
        type: r.type,
        value: r.content,
        ttl: r.ttl,
        managed: typeof r.comment === 'string' && r.comment.startsWith(CF_TAG),
      });
    }
    const pages = body.result_info?.total_pages ?? 1;
    if (page >= pages) break;
  }
  return out;
}

const cloudflareProvider: DnsProvider = {
  name: 'cloudflare',
  async syncZone(snapshot, opts) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const desired = desiredRecords(snapshot);
    const existing = await cfList(opts.zoneId, opts.token, fetchImpl);
    const diff = diffRecords(desired, existing);

    const planned: RecordChange[] = [
      ...diff.create.map<RecordChange>((d) => ({
        op: 'create',
        host: d.host,
        type: d.type,
        value: d.value,
        region: d.region,
      })),
      ...diff.delete.map<RecordChange>((e) => ({
        op: 'delete',
        host: e.host,
        type: e.type === 'CNAME' ? 'CNAME' : 'A',
        value: e.value,
      })),
    ];
    const result: ProviderSyncResult = { provider: 'cloudflare', planned, applied: 0, errors: [] };
    if (opts.dryRun) return result;

    for (const d of diff.create) {
      const res = await fetchImpl(`${CF_API}/zones/${opts.zoneId}/dns_records`, {
        method: 'POST',
        headers: { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          type: d.type,
          name: d.host,
          content: d.value,
          ttl: Math.max(1, snapshot.ttl),
          comment: `${CF_TAG} region=${d.region}`,
        }),
      });
      if (res.ok) result.applied++;
      else result.errors.push(`create ${d.host} ${d.value}: ${res.status}`);
    }
    for (const e of diff.delete) {
      const res = await fetchImpl(`${CF_API}/zones/${opts.zoneId}/dns_records/${e.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${opts.token}` },
      });
      if (res.ok) result.applied++;
      else result.errors.push(`delete ${e.host} ${e.value}: ${res.status}`);
    }
    return result;
  },
};

// ───────────────────────────────────────────── Route53 (SigV4) ──

const R53_HOST = 'route53.amazonaws.com';
const R53_API = `https://${R53_HOST}/2013-04-01`;

/** swarmy region label → AWS region (for latency-routing RRSets). */
const AWS_REGION_BY_LABEL: Record<string, string> = {
  'us-east': 'us-east-1',
  'us-east-1': 'us-east-1',
  'us-west': 'us-west-2',
  'us-west-1': 'us-west-1',
  'us-central': 'us-east-2',
  'ca-central': 'ca-central-1',
  'sa-east': 'sa-east-1',
  'eu-west': 'eu-west-1',
  'eu-west-1': 'eu-west-1',
  'eu-central': 'eu-central-1',
  'eu-north': 'eu-north-1',
  'eu-south': 'eu-south-1',
  'me-south': 'me-south-1',
  'af-south': 'af-south-1',
  'ap-south': 'ap-south-1',
  'ap-southeast': 'ap-southeast-1',
  'ap-northeast': 'ap-northeast-1',
  'ap-east': 'ap-east-1',
};

const awsRegionFor = (label: string): string =>
  AWS_REGION_BY_LABEL[label.trim().toLowerCase()] ?? 'us-east-1';

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (k: Buffer | string, data: string): Buffer =>
  createHmac('sha256', k).update(data, 'utf8').digest();

interface AwsCreds {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

function parseAwsCreds(token: string): AwsCreds {
  const [accessKeyId = '', secretAccessKey = '', sessionToken] = token.split(':');
  return { accessKeyId, secretAccessKey, sessionToken: sessionToken || undefined };
}

/** Minimal AWS SigV4 for a single request. Returns headers to send. */
function signV4(input: {
  method: string;
  url: string;
  region: string;
  service: string;
  creds: AwsCreds;
  body: string;
  now?: Date;
}): Record<string, string> {
  const { method, region, service, creds, body } = input;
  const url = new URL(input.url);
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  const payloadHash = sha256Hex(body);
  const headers: Record<string, string> = {
    host: url.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
  };
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;

  const signedHeaderNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const canonicalHeaders =
    signedHeaderNames.map((h) => `${h}:${headers[h]}\n`).join('') + '';
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    method,
    url.pathname,
    url.searchParams.toString(),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}

const xmlEscape = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
  );

/** Build a Route53 ChangeResourceRecordSets XML body from a change list. */
export function route53ChangeXml(
  changes: Array<{
    action: 'UPSERT' | 'DELETE';
    name: string;
    type: 'A' | 'CNAME';
    value: string;
    ttl: number;
    setIdentifier?: string;
    awsRegion?: string;
  }>,
): string {
  const items = changes
    .map((c) => {
      const routing =
        c.setIdentifier && c.awsRegion
          ? `<SetIdentifier>${xmlEscape(c.setIdentifier)}</SetIdentifier><Region>${xmlEscape(c.awsRegion)}</Region>`
          : '';
      return (
        `<Change><Action>${c.action}</Action><ResourceRecordSet>` +
        `<Name>${xmlEscape(c.name)}</Name><Type>${c.type}</Type>` +
        routing +
        `<TTL>${c.ttl}</TTL>` +
        `<ResourceRecords><ResourceRecord><Value>${xmlEscape(c.value)}</Value></ResourceRecord></ResourceRecords>` +
        `</ResourceRecordSet></Change>`
      );
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/">` +
    `<ChangeBatch><Comment>${CF_TAG}</Comment><Changes>${items}</Changes></ChangeBatch>` +
    `</ChangeResourceRecordSetsRequest>`
  );
}

/** Parse the rrset list XML just enough to find swarmy-managed records to delete. */
export function parseRoute53Rrsets(xml: string): ExistingRecord[] {
  const out: ExistingRecord[] = [];
  const blocks = xml.match(/<ResourceRecordSet>[\s\S]*?<\/ResourceRecordSet>/g) ?? [];
  for (const b of blocks) {
    const name = /<Name>([^<]*)<\/Name>/.exec(b)?.[1] ?? '';
    const type = /<Type>([^<]*)<\/Type>/.exec(b)?.[1] ?? '';
    const setId = /<SetIdentifier>([^<]*)<\/SetIdentifier>/.exec(b)?.[1];
    if (type !== 'A' && type !== 'CNAME') continue;
    const values = [...b.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => m[1] ?? '');
    for (const value of values) {
      out.push({
        id: setId ?? `${name}|${type}|${value}`,
        host: name.replace(/\.$/, ''),
        type,
        value,
        // swarmy-managed RRSets carry a region SetIdentifier; plain records are
        // left untouched (we only ever delete what we created).
        managed: setId !== undefined,
      });
    }
  }
  return out;
}

async function r53Request(
  method: string,
  path: string,
  body: string,
  opts: ProviderSyncOptions,
): Promise<Response> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const region = opts.region ?? 'us-east-1';
  const url = `${R53_API}${path}`;
  const headers = signV4({
    method,
    url,
    region,
    service: 'route53',
    creds: parseAwsCreds(opts.token),
    body,
  });
  return fetchImpl(url, { method, headers, body: body || undefined });
}

const route53Provider: DnsProvider = {
  name: 'route53',
  async syncZone(snapshot, opts) {
    const desired = desiredRecords(snapshot);

    // Group desired by host to decide simple vs latency-routed RRSets.
    const byHost = new Map<string, DesiredRecord[]>();
    for (const d of desired) {
      const list = byHost.get(d.host) ?? [];
      list.push(d);
      byHost.set(d.host, list);
    }

    const changes: Parameters<typeof route53ChangeXml>[0] = [];
    const planned: RecordChange[] = [];
    for (const [host, recs] of byHost) {
      const regions = new Set(recs.map((r) => r.region));
      const latency = regions.size > 1; // latency routing only when a host spans regions
      for (const r of recs) {
        changes.push({
          action: 'UPSERT',
          name: host.endsWith('.') ? host : `${host}.`,
          type: r.type,
          value: r.value,
          ttl: Math.max(1, snapshot.ttl),
          ...(latency
            ? { setIdentifier: `swarmy-${r.region}`, awsRegion: awsRegionFor(r.region) }
            : {}),
        });
        planned.push({ op: 'create', host, type: r.type, value: r.value, region: r.region });
      }
    }

    const result: ProviderSyncResult = { provider: 'route53', planned, applied: 0, errors: [] };
    if (opts.dryRun || changes.length === 0) return result;

    const xml = route53ChangeXml(changes);
    const res = await r53Request(
      'POST',
      `/hostedzone/${opts.zoneId}/rrset`,
      xml,
      opts,
    );
    if (res.ok) result.applied = changes.length;
    else result.errors.push(`route53 change ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return result;
  },
};

// ───────────────────────────────────────────── registry ──

const PROVIDERS: Record<ProviderName, DnsProvider> = {
  cloudflare: cloudflareProvider,
  route53: route53Provider,
};

/** Provider names that trigger an external sync (not the self-host CoreDNS). */
export function isSyncProvider(name: string): name is ProviderName {
  return name === 'cloudflare' || name === 'route53';
}

export function getDnsProvider(name: string): DnsProvider | null {
  return isSyncProvider(name) ? PROVIDERS[name] : null;
}

/** Convenience: pick the adapter by name and reconcile the zone. */
export async function syncProviderZone(
  name: string,
  snapshot: ProviderZoneSnapshot,
  opts: ProviderSyncOptions,
): Promise<ProviderSyncResult> {
  const provider = getDnsProvider(name);
  if (!provider) throw new Error(`unknown DNS provider: ${name}`);
  return provider.syncZone(snapshot, opts);
}
