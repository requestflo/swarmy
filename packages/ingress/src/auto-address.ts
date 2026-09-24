/**
 * Automatic app addresses — pure.
 *
 * Every public HTTP service gets a working HTTPS address the moment it
 * deploys, before anyone owns a domain. Preferred: `<service>-<stack>.<zone>`
 * in the org's OWN zone served by swarmy-dns (flagged with
 * `geodns.setZoneAutoAddresses`, which requires live NS delegation) — no third
 * party in the path. Fallback when no zone is delegated:
 * `<service>-<stack>.<edge-ip>.sslip.io`
 * (sslip.io answers any `<anything>.<a-b-c-d>.sslip.io` with `a.b.c.d`, so the
 * name points at the edge by construction — no DNS step, instantly verified).
 * Public IPs get a real Let's Encrypt certificate (sslip.io is on the Public
 * Suffix List, so every IP is its own rate-limit bucket); private IPs get the
 * edge's local CA like every other LAN name.
 *
 * The address is a REAL route on the service's `swarmy.ingress.routes` label
 * (exportable, editable, removable like any other), stamped once by the
 * domain-verify worker. The marker label `swarmy.ingress.auto.host` records
 * what swarmy stamped, so:
 *   - removing the route keeps the marker → swarmy never re-adds it;
 *   - adding a custom domain first → no auto address (the custom one replaces it);
 *   - the edge IP changing → the stamped route is re-hosted onto the new base;
 *   - `swarmy.ingress.auto=false` opts a service out entirely.
 *
 * WHO qualifies (never widen exposure silently): a service that already
 * PUBLISHES a TCP port (world-reachable today, over plain HTTP), or that
 * declares `swarmy.expose=public`, or opts in with `swarmy.ingress.auto=true`.
 * Services declared private/mesh/tunnel, managed data, and swarmy's own
 * services are never given one.
 */

export const AUTO_ADDRESS_LABEL = 'swarmy.ingress.auto';
export const AUTO_ADDRESS_HOST_LABEL = 'swarmy.ingress.auto.host';
export const AUTO_ADDRESS_PORT_LABEL = 'swarmy.ingress.auto.port';

const MANAGED_PREFIXES = ['swarmy.db.', 'swarmy.cache.', 'swarmy.search.', 'swarmy.vector.'];
/** Well-known ports that are never HTTP (databases, brokers, mail, ssh, dns). */
const NON_HTTP_PORTS = new Set([
  21, 22, 23, 25, 53, 110, 143, 389, 465, 587, 636, 993, 995, 1433, 1521, 1883, 2181, 2379, 2380, 3306,
  4222, 5432, 5672, 6379, 6380, 7000, 7001, 8883, 9042, 9092, 9093, 11211, 15672, 25565, 26257, 27017, 27018,
]);
/** Preferred HTTP ports, in order, when a service offers several. */
const HTTP_PREFERENCE = [80, 8080, 3000, 8000, 5000, 4000, 8888, 3001, 5173, 4200, 9000, 1337, 8081];

/** The sslip.io base for this org's edge, or null when no address can be formed. */
export function sslipBaseFor(input: { dashboardDomain?: string | null; edgeIps: readonly string[] }): string | null {
  const d = input.dashboardDomain?.trim().toLowerCase().replace(/\.$/, '');
  if (d) {
    // The installer's `swarmy.<a-b-c-d>.sslip.io` (dashed or dotted, sslip or nip).
    const dashed = d.match(/(?:^|\.)(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.(sslip\.io|nip\.io)$/);
    if (dashed) return `${dashed[1]}.${dashed[2]}`;
    const dotted = d.match(/(?:^|\.)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(sslip\.io|nip\.io)$/);
    if (dotted) return `${dotted.slice(1, 5).join('-')}.${dotted[5]}`;
  }
  const ips = [...input.edgeIps].sort();
  const v4 = ips.find((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
  if (v4) return `${v4.replace(/\./g, '-')}.sslip.io`;
  const v6 = ips.find((ip) => ip.includes(':'));
  if (v6) return `${v6.toLowerCase().replace(/:/g, '-')}.sslip.io`;
  return null;
}

/** Short stable hash (FNV-1a, base36) — collision suffixes and long-label truncation. */
function hash6(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(6, '0').slice(-6);
}

function sanitizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * The DNS label for a service: `<service>-<stack>` (the stack prefix Docker
 * adds to the service name is dropped first), just `<service>` standalone.
 * Always a valid ≤63-char label; long names are truncated + hashed.
 */
export function autoLabelFor(stack: string | null | undefined, serviceName: string): string {
  const standalone = !stack || stack === '(ungrouped)';
  const svc = !standalone && serviceName.startsWith(`${stack}_`) ? serviceName.slice(stack.length + 1) : serviceName;
  const raw = standalone ? svc : `${svc}-${stack}`;
  const label = sanitizeLabel(raw) || `svc-${hash6(serviceName)}`;
  return label.length <= 63 ? label : `${label.slice(0, 56).replace(/-$/, '')}-${hash6(serviceName)}`;
}

/** Pick the port to route to, or null when nothing looks like HTTP. */
export function pickHttpPort(ports: readonly number[]): number | null {
  const candidates = [...new Set(ports)].filter((p) => Number.isInteger(p) && p > 0 && p < 65536 && !NON_HTTP_PORTS.has(p));
  if (candidates.length === 0) return null;
  for (const p of HTTP_PREFERENCE) if (candidates.includes(p)) return p;
  return candidates.sort((a, b) => a - b)[0]!;
}

export interface AutoAddressCandidate {
  serviceId: string;
  serviceName: string;
  stack: string;
  labels: Record<string, string>;
  /** Service-spec ports (`published` present ⇒ world-reachable today). */
  ports: ReadonlyArray<{ target: number; published?: number; protocol: string }>;
  /** Ports the service's containers expose (image EXPOSE). */
  exposedTcp: readonly number[];
  /** Hosts on this service's route label right now. */
  routeHosts: readonly string[];
}

export type AutoAddressAction =
  | { kind: 'add'; serviceId: string; serviceName: string; host: string; port: number }
  | { kind: 'rehost'; serviceId: string; serviceName: string; host: string; previousHost: string };

export type AutoAddressSkip =
  | 'opted-out'
  | 'system'
  | 'managed-data'
  | 'not-public'
  | 'has-domain'
  | 'removed'
  | 'no-http-port'
  | 'current';

/** Why a service does / doesn't get an auto address (the UI explains it). */
export function autoAddressEligibility(c: AutoAddressCandidate): { port: number } | { skip: AutoAddressSkip } {
  const l = c.labels;
  if (l[AUTO_ADDRESS_LABEL] === 'false') return { skip: 'opted-out' };
  if (c.stack === 'swarmy' || /^swarmy[-_]/.test(c.serviceName)) return { skip: 'system' };
  if (Object.keys(l).some((k) => MANAGED_PREFIXES.some((p) => k.startsWith(p)))) return { skip: 'managed-data' };
  const intent = l['swarmy.expose'];
  if (intent === 'private' || intent === 'mesh' || intent === 'tunnel') return { skip: 'not-public' };
  const override = Number(l[AUTO_ADDRESS_PORT_LABEL]);
  const published = c.ports.filter((p) => p.published !== undefined && p.protocol !== 'udp').map((p) => p.target);
  const optedIn = l[AUTO_ADDRESS_LABEL] === 'true' || intent === 'public';
  if (published.length === 0 && !optedIn) return { skip: 'not-public' };
  if (Number.isInteger(override) && override > 0 && override < 65536) return { port: override };
  const port = pickHttpPort(published.length > 0 ? published : [...c.exposedTcp, ...c.ports.filter((p) => p.protocol !== 'udp').map((p) => p.target)]);
  return port === null ? { skip: 'no-http-port' } : { port };
}

/**
 * Plan the label writes that converge auto addresses for an org. Pure and
 * idempotent: at steady state it returns []. `takenHosts` = every host routed
 * anywhere in the org (so an auto host never shadows a real one).
 */
export function planAutoAddresses(input: {
  candidates: readonly AutoAddressCandidate[];
  base: string | null;
  takenHosts: readonly string[];
}): AutoAddressAction[] {
  const { base } = input;
  if (!base) return [];
  const taken = new Set(input.takenHosts.map((h) => h.toLowerCase()));
  const out: AutoAddressAction[] = [];
  const sorted = [...input.candidates].sort((a, b) => (a.serviceName < b.serviceName ? -1 : 1));
  for (const c of sorted) {
    const marker = c.labels[AUTO_ADDRESS_HOST_LABEL];
    if (c.labels[AUTO_ADDRESS_LABEL] === 'false') continue;
    if (marker) {
      // Already stamped: re-host only if the route is still ours and the base moved.
      if (!c.routeHosts.includes(marker)) continue; // user removed it — respect that
      if (marker.endsWith(`.${base}`)) continue;
      const label = marker.split('.')[0]!;
      let host = `${label}.${base}`;
      if (taken.has(host)) host = `${label}-${hash6(c.serviceName)}.${base}`;
      taken.add(host);
      out.push({ kind: 'rehost', serviceId: c.serviceId, serviceName: c.serviceName, host, previousHost: marker });
      continue;
    }
    if (c.routeHosts.length > 0) continue; // a custom domain replaces the auto address
    const elig = autoAddressEligibility(c);
    if (!('port' in elig)) continue;
    const label = autoLabelFor(c.stack, c.serviceName);
    let host = `${label}.${base}`;
    if (taken.has(host)) host = `${label.slice(0, 56).replace(/-$/, '')}-${hash6(c.serviceName)}.${base}`;
    taken.add(host);
    out.push({ kind: 'add', serviceId: c.serviceId, serviceName: c.serviceName, host, port: elig.port });
  }
  return out;
}
