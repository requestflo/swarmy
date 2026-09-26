import type { DnsRecordHint, DomainPlan, WwwMode } from '@/components/ingress/domain-state';
import { companionOf, normalizeHost } from './host-shape';

/** One row of "create exactly this". `glue` rows are the nameserver IPs (set at the registrar). */
export interface PlanRow {
  type: DnsRecordHint['type'] | 'glue';
  /** What the registrar's host box wants (`@`, `www`, `ns1`). */
  label: string;
  value: string;
  /** Which edge server this value is, or a quiet note ("follows the apex"). */
  note: string | null;
}

export type DnsMode = 'registrar' | 'nameserver';

function edgeName(plan: DomainPlan, ip: string): string | null {
  const e = plan.edges.find((x) => x.ip === ip);
  return e?.name ?? null;
}

/**
 * The exact records for the chosen host, www choice and DNS mode — the
 * controller's guidance (`ingress.domainPlan`) plus, when www is on, the
 * companion's record: a CNAME to the apex for `www.` (it follows the apex's
 * addresses), or the apex's own A records when the typed host is the `www.`.
 */
export function planRows(plan: DomainPlan, mode: DnsMode, www: WwwMode | 'none'): PlanRow[] {
  if (mode === 'nameserver' && plan.nameserver) {
    const ns = plan.nameserver;
    const nsRows = ns.guidance.records.map((r) => ({ type: r.type, label: r.label, value: r.value, note: null }));
    const glue = ns.nameservers
      .filter((n) => n.ip)
      .map((n) => ({ type: 'glue' as const, label: n.fqdn.slice(0, -(ns.zone.length + 1)) || n.fqdn, value: n.ip, note: edgeName(plan, n.ip) }));
    return [...nsRows, ...glue];
  }
  const rows: PlanRow[] = plan.registrar.records.map((r) => ({
    type: r.type,
    label: r.label,
    value: r.value,
    note: r.type === 'A' || r.type === 'AAAA' ? edgeName(plan, r.value) : (r.note ?? null),
  }));
  if (www === 'none' || plan.registrar.mode !== 'records') return rows;
  const host = normalizeHost(plan.host);
  const other = companionOf(host);
  if (!other) return rows;
  if (!host.startsWith('www.')) {
    const label = rows[0]?.label === '@' ? 'www' : `www.${rows[0]?.label ?? ''}`.replace(/\.$/, '');
    return [...rows, { type: 'CNAME', label, value: `${host}.`, note: 'follows the apex' }];
  }
  // Typed www.x: the apex needs its own addresses (an apex can't be a CNAME).
  const apexLabel = rows[0]?.label === 'www' ? '@' : other;
  return [...rows, ...rows.filter((r) => r.type === 'A' || r.type === 'AAAA').map((r) => ({ ...r, label: apexLabel }))];
}

/** "Add 3 records" / "Add one record" / "Delegate x to swarmy". */
export function planTitle(rows: PlanRow[], mode: DnsMode, zone: string | null, where: string): string {
  if (mode === 'nameserver' && zone) return `Point ${zone} at swarmy’s nameservers`;
  const n = rows.filter((r) => r.type !== 'glue').length;
  if (n === 0) return 'Nothing to add yet';
  return `Add ${n === 1 ? 'one record' : `${n} records`} at ${where}`;
}
