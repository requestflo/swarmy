import type { DnsRecordView, DnsViewRow } from './geo-types';

/** One line of the zone's records table: automatic (derived from your addresses) or yours. */
export interface RecordLine {
  key: string;
  type: string;
  name: string;
  value: string;
  source: 'automatic' | 'you';
  /** Manual records only: what removeRecord takes. */
  id?: string;
  ttl?: number | null;
}

/** The record types you add by hand here. Web addresses are automatic. */
export const ADDABLE_TYPES = ['TXT', 'MX', 'CNAME', 'SRV', 'CAA'] as const;
export type AddableType = (typeof ADDABLE_TYPES)[number];

const TYPE_ORDER = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];

/** `shop.northwind.dev` in `northwind.dev` → `shop`; the apex → `@`. */
export function relName(host: string, zone: string): string {
  if (host === zone) return '@';
  return host.endsWith(`.${zone}`) ? host.slice(0, -(zone.length + 1)) : host;
}

/** "a b c +3" — the first few names, then how many more. */
function someNames(names: string[], max = 3): string {
  return names.length <= max ? names.join(' ') : `${names.slice(0, max).join(' ')} +${names.length - max}`;
}

/** "nearest of mgr-1, mgr-2 · wkr-3 out" — every endpoint the derived record answers from. */
function nearestOf(rows: DnsViewRow[], nameOf: (ip: string) => string): string {
  const eps = new Map<string, boolean>();
  for (const r of rows) for (const e of r.endpoints) eps.set(e.ip, (eps.get(e.ip) ?? false) || e.healthy);
  const healthy = [...eps].filter(([, ok]) => ok).map(([ip]) => nameOf(ip));
  const out = [...eps].filter(([, ok]) => !ok).map(([ip]) => nameOf(ip));
  if (eps.size === 0) return 'no front door yet';
  const head = healthy.length ? `nearest of ${healthy.join(', ')}` : `all of ${out.join(', ')} (none healthy)`;
  return healthy.length && out.length ? `${head} · ${out.join(', ')} out` : head;
}

/**
 * The zone's records as one table: the automatic web records (grouped as the
 * board does: apex + www, then every routed address) followed by yours.
 */
export function mergeRecords(
  zone: string,
  view: DnsViewRow[],
  manual: DnsRecordView[],
  nameOf: (ip: string) => string,
): RecordLine[] {
  const inZone = view.filter((r) => r.zone === zone);
  const apex = inZone.filter((r) => r.source === 'apex' || r.source === 'www');
  const routed = inZone.filter((r) => r.source !== 'apex' && r.source !== 'www');
  const auto: RecordLine[] = [];
  if (apex.length) {
    auto.push({ key: 'auto-apex', type: 'A', name: apex.map((r) => relName(r.host, zone)).join(' · '), value: nearestOf(apex, nameOf), source: 'automatic' });
  }
  if (routed.length) {
    const names = [...new Set(routed.map((r) => relName(r.host, zone)))];
    auto.push({ key: 'auto-routes', type: 'A', name: someNames(names), value: nearestOf(routed, nameOf), source: 'automatic' });
  }
  const yours = [...manual]
    .sort((a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.name.localeCompare(b.name) || (a.priority ?? 0) - (b.priority ?? 0))
    .map<RecordLine>((r) => ({
      key: r.id,
      id: r.id,
      type: r.type,
      name: r.name,
      value: r.priority != null && (r.type === 'MX' || r.type === 'SRV') ? `${r.priority} ${r.value}` : r.value,
      source: 'you',
      ttl: r.ttl,
    }));
  return [...auto, ...yours];
}

/** What a value looks like for each addable type (the add row's placeholder). */
export const VALUE_HINT: Record<AddableType, string> = {
  TXT: 'v=DMARC1; p=quarantine',
  MX: 'mx1.example.com',
  CNAME: 'target.example.com',
  SRV: '5 5060 sip.example.com',
  CAA: '0 issue "letsencrypt.org"',
};
