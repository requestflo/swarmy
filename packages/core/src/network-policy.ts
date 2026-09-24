/**
 * swarmy's network model — the ONE place that says which overlay is for whom.
 * PURE (no node:*, browser-safe) so the controller, the agent, the dashboard
 * and the golden tests share the exact same rules.
 *
 *   swarmy-control  PRIVATE. The control plane: the controller, its Postgres,
 *                   ClickHouse — plus the trusted platform bridges that must
 *                   reach them (edge Caddy → dashboard vhost, cloudflared,
 *                   the OTel collector → ClickHouse, the node-#1 agent).
 *                   A user service NEVER joins it (admission refuses).
 *   swarmy          SHARED platform services network (the "edge"): routed
 *                   services meet the edge Caddy here; observed services meet
 *                   the OTel collector; bucket-attached apps meet
 *                   `swarmy-garage`. Services here can see each other's
 *                   VIPs, so nothing secret lives on it and NO user service
 *                   may register a DNS alias on it (an alias like `postgres`
 *                   or `swarmy_controller` would let an app impersonate a
 *                   platform name to a trusted dual-homed client).
 *   <app>_default   PER APP. Every compose service joins it with its SHORT
 *                   name as an alias — `db:5432` resolves inside the app,
 *                   and only there.
 *   <managed>-net   PER MANAGED RESOURCE (`<app>_<db>-net`, `…-cache-net`,
 *                   …). Only the resource and the apps attached to it.
 *   swarmy-link-*   PER CONNECTED APP PAIR (explicit "connect apps"). Both
 *                   apps' services, aliased `<service>.<app>`.
 */

/** The shared platform-services ("edge") overlay. Mirrors `SWARMY_OVERLAY_NETWORK`. */
export const SHARED_PLATFORM_NETWORK = 'swarmy';
/** The private control-plane overlay. User services never join it. */
export const SWARMY_CONTROL_NETWORK = 'swarmy-control';
/** Prefix of per-app-pair "connect apps" overlays. */
export const LINK_NETWORK_PREFIX = 'swarmy-link-';
/** Service label listing the peer apps a service's app is connected to (sorted, comma-joined). */
export const LINKS_LABEL = 'swarmy.links';
/** Network labels on a link overlay. */
export const LINK_ORG_LABEL = 'swarmy.link.org';
export const LINK_STACKS_LABEL = 'swarmy.link.stacks';

/** Docker overlay driver option carrying the MTU (a string, per Docker). */
export const OVERLAY_MTU_OPTION = 'com.docker.network.driver.mtu';
/** Docker overlay driver option turning on IPsec (value is ignored; `''` is conventional). */
export const OVERLAY_ENCRYPTED_OPTION = 'encrypted';

/** Networks a user-supplied service spec may attach to but never alias on. */
export const PLATFORM_SHARED_NETWORKS: ReadonlySet<string> = new Set([SHARED_PLATFORM_NETWORK]);
/** Networks a user-supplied service spec may never attach to at all. */
export const PLATFORM_PRIVATE_NETWORKS: ReadonlySet<string> = new Set([SWARMY_CONTROL_NETWORK]);

export function isPlatformNetwork(name: string): boolean {
  return PLATFORM_SHARED_NETWORKS.has(name) || PLATFORM_PRIVATE_NETWORKS.has(name);
}

// ─────────────────────────────────────────────────────────────── MTU ──

/** VXLAN encapsulation overhead (outer IPv4 20 + UDP 8 + VXLAN 8 + inner Ethernet 14). */
export const VXLAN_OVERHEAD = 50;
/** Headroom for the IPsec ESP an encrypted overlay adds (SPI/seq 8 + IV 8 + pad/trailer ≤ 18 + ICV 16, rounded up). */
export const IPSEC_OVERHEAD = 60;

/**
 * The WireGuard interface MTU each mesh driver brings up. NetBird (`wt0`)
 * and Tailscale (`tailscale0`) default to 1280; raw WireGuard (`wg0`) to 1420.
 * `none` = no mesh, underlay MTU (1500) — Docker's default is already right.
 */
export function meshLinkMtu(driver: string | null | undefined): number | undefined {
  switch ((driver ?? 'none').toLowerCase()) {
    case 'netbird':
    case 'headscale':
    case 'tailscale':
      return 1280;
    case 'wireguard':
      return 1420;
    default:
      return undefined;
  }
}

/**
 * Overlay MTU that fits inside a `linkMtu` path: the VXLAN frame (and ESP,
 * when encrypted) must not exceed the underlay, or large packets fragment at
 * best and silently black-hole at worst (TLS handshakes and big responses
 * stall while pings succeed). `undefined` link = leave Docker's default.
 */
export function overlayMtuFor(linkMtu: number | undefined, encrypted = false): number | undefined {
  if (!linkMtu) return undefined;
  return linkMtu - VXLAN_OVERHEAD - (encrypted ? IPSEC_OVERHEAD : 0);
}

/**
 * Driver options for a new overlay: `mtu` when the swarm data path rides a
 * mesh, `encrypted` when asked. Returns `undefined` when nothing needs setting
 * so payloads stay identical to before for mesh-less installs.
 */
export function overlayDriverOptions(opts: {
  meshDriver?: string | null;
  meshEnabled?: boolean;
  encrypted?: boolean;
  /** Caller-supplied options (compose `driver_opts`) — they win. */
  extra?: Record<string, string>;
}): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (opts.encrypted) out[OVERLAY_ENCRYPTED_OPTION] = '';
  const mtu = opts.meshEnabled ? overlayMtuFor(meshLinkMtu(opts.meshDriver), !!opts.encrypted || OVERLAY_ENCRYPTED_OPTION in (opts.extra ?? {})) : undefined;
  if (mtu) out[OVERLAY_MTU_OPTION] = String(mtu);
  Object.assign(out, opts.extra ?? {});
  return Object.keys(out).length ? out : undefined;
}

// ─────────────────────────────────────────────── connect apps (links) ──

/** Tiny, stable, browser-safe 64-bit FNV-1a → 16 hex chars. Not security-relevant; uniqueness only. */
function fnv64hex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193 ^ 0x2f) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** The two apps of a pair in canonical (sorted) order. */
export function linkPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Name of the private overlay pairing apps `a` and `b` of `orgId`. Order-free
 * (`a,b` ≡ `b,a`) and org-qualified, so two orgs that both have `shop` and
 * `billing` never share a link.
 */
export function linkNetworkName(orgId: string, a: string, b: string): string {
  const [x, y] = linkPair(a, b);
  return `${LINK_NETWORK_PREFIX}${fnv64hex(`${orgId}\u0000${x}\u0000${y}`)}`;
}

/** DNS alias a service of `app` answers to on a link overlay: `<service>.<app>`. */
export function linkAlias(app: string, shortService: string): string {
  return `${shortService}.${app}`;
}

/** Parse / render the `swarmy.links` service label. */
export function parseLinksLabel(value: string | undefined): string[] {
  return [...new Set((value ?? '').split(',').map((s) => s.trim()).filter(Boolean))].sort();
}
export function renderLinksLabel(peers: Iterable<string>): string {
  return [...new Set(peers)].filter(Boolean).sort().join(',');
}

// ───────────────────────────────────────────────── isolation guard ──

/** Minimal spec shape the guard reads (a `ServiceSpec` satisfies it). */
export interface NetworkedSpecLike {
  name?: string;
  networks?: string[];
  networkAliases?: Record<string, string[]>;
}

export interface NetworkIsolationViolation {
  rule: 'network.control-plane' | 'network.platform-alias' | 'platform.reserved-name';
  message: string;
  resource?: string;
}

/**
 * Service names swarmy's own plumbing uses: the controller stack (`swarmy_*`:
 * `swarmy_controller`, `swarmy_postgres`) and every platform service
 * (`swarmy-*`: ingress Caddy, Garage, ClickHouse, the OTel collector, the
 * registry, …). A swarm service name is also its DNS name, and `service.deploy`
 * is create-OR-UPDATE by name — a user spec named `swarmy_controller` would
 * replace the control plane; one named `swarmy-otel-collector` (before
 * observability is on) would receive every app's telemetry.
 */
export function isReservedServiceName(name: string): boolean {
  return /^swarmy[-_]/.test(name) || name === 'swarmy';
}

/**
 * Violations of the network wall in USER-supplied specs. Not a policy knob:
 * callers refuse the deploy outright, overrides included.
 *  - joining `swarmy-control` (the controller's database lives there);
 *  - any DNS alias on the shared `swarmy` network (impersonation of
 *    `postgres` / `swarmy_controller` / `swarmy-garage` to the dual-homed
 *    edge, collector and agent);
 *  - a platform service NAME (squatting or overwriting it).
 */
export function networkIsolationViolations(specs: readonly unknown[] | undefined): NetworkIsolationViolation[] {
  const out: NetworkIsolationViolation[] = [];
  for (const raw of specs ?? []) {
    const spec = (raw ?? {}) as NetworkedSpecLike;
    const name = spec.name ?? '(unnamed)';
    if (spec.name && isReservedServiceName(spec.name)) {
      out.push({
        rule: 'platform.reserved-name',
        message: `service names starting with \`swarmy-\` / \`swarmy_\` are reserved for swarmy's own platform services`,
        resource: name,
      });
    }
    for (const net of spec.networks ?? []) {
      if (PLATFORM_PRIVATE_NETWORKS.has(net)) {
        out.push({
          rule: 'network.control-plane',
          message: `\`${net}\` is swarmy's private control-plane network — app services can't join it`,
          resource: name,
        });
      }
    }
    for (const [net, aliases] of Object.entries(spec.networkAliases ?? {})) {
      if (PLATFORM_SHARED_NETWORKS.has(net) && aliases.length > 0) {
        out.push({
          rule: 'network.platform-alias',
          message: `DNS aliases on the shared \`${net}\` network are not allowed (${aliases.join(', ')}) — they could impersonate platform services; use an app network or "connect apps"`,
          resource: name,
        });
      }
    }
  }
  return out;
}

/** Strip every alias a spec sets on a platform network (swarmy's own attach paths). Pure. */
export function stripPlatformAliases<T extends NetworkedSpecLike>(spec: T): T {
  if (!spec.networkAliases) return spec;
  const kept = Object.fromEntries(
    Object.entries(spec.networkAliases).filter(([net]) => !isPlatformNetwork(net)),
  );
  return { ...spec, networkAliases: kept };
}
