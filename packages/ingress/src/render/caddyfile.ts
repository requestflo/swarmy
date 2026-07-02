import type { DomainRoute, IngressConfig } from '../types';

/** Build a Caddyfile from an org ingress config. Pure string construction. */
export function buildCaddyfile(config: IngressConfig): string {
  const out: string[] = [];
  const extra = config.globalOptions.extraConfig as Record<string, unknown>;

  const global: string[] = [];
  // When applies are pushed to the controller's admin API (`applyVia: 'admin'`),
  // the rendered config MUST keep the admin endpoint bound on the overlay (0.0.0.0)
  // — otherwise the first `/load` rebinds it to localhost (Caddy's default) and the
  // agent, which reaches Caddy over the overlay from another container, is locked out
  // of every subsequent push (and `--resume` would restore a localhost-only admin).
  const applyVia = typeof extra.applyVia === 'string' ? extra.applyVia : 'file';
  if (applyVia === 'admin') {
    const adminListen = typeof extra.adminListen === 'string' ? extra.adminListen : '0.0.0.0:2019';
    global.push(`  admin ${adminListen}`);
  }
  if (config.globalOptions.email) global.push(`  email ${config.globalOptions.email}`);
  if (config.globalOptions.onDemandTls) {
    global.push('  on_demand_tls {');
    if (typeof extra.onDemandAsk === 'string') global.push(`    ask ${extra.onDemandAsk}`);
    global.push('  }');
  }
  // Caddy HA: a shared Redis cert/ACME store (caddy-storage-redis). When enabled,
  // every Caddy instance points at the same Redis → one ACME account + cert pool,
  // so the existing per-node fan-out *becomes* an HA cluster (no re-issuance).
  const ha = config.globalOptions.haStorage;
  if (ha) {
    global.push('  storage redis {');
    global.push(`    host ${ha.host}`);
    global.push(`    port ${ha.port}`);
    global.push(`    db ${ha.db}`);
    global.push(`    key_prefix ${ha.keyPrefix}`);
    if (ha.username) global.push(`    username ${ha.username}`);
    if (ha.password) global.push(`    password ${ha.password}`);
    global.push(`    tls_enabled ${ha.tlsEnabled ? 'true' : 'false'}`);
    if (ha.encryptionKey) global.push(`    encryption_key ${ha.encryptionKey}`);
    global.push('  }');
  }
  if (global.length) {
    out.push('{', ...global, '}', '');
  }

  // The org's FULL route set — every service's routes, already flattened into
  // `config.domains` by the controller (listRoutesForOrg) — is grouped by HOST so
  // path-based routing across containers collapses into ONE Caddy site block per
  // host. Caddy rejects duplicate site addresses, so two services sharing a host
  // (xyz.com/app → appA, xyz.com/app/api → appB; or http + ws on one host) MUST
  // live in a single block. Within it, routes are ordered longest-prefix-first so
  // the most specific path wins (Caddy evaluates `handle` blocks top-to-bottom and
  // the first match handles the request).
  for (const [host, routes] of groupByHost(config.domains)) {
    out.push(...buildSite(host, routes, config), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** Group routes by host, preserving first-seen host order for stable output. */
function groupByHost(domains: readonly DomainRoute[]): Map<string, DomainRoute[]> {
  const byHost = new Map<string, DomainRoute[]>();
  for (const d of domains) {
    const list = byHost.get(d.domain);
    if (list) list.push(d);
    else byHost.set(d.domain, [d]);
  }
  return byHost;
}

/** A route's path prefix, normalised so an empty/undefined prefix is the root `/`. */
function routePath(r: DomainRoute): string {
  return r.pathPrefix && r.pathPrefix.length > 0 ? r.pathPrefix : '/';
}

/**
 * One TLS mode per host — the site address carries a single scheme. A custom
 * operator cert on ANY route governs the host; a host whose EVERY route is `off`
 * serves plain http; otherwise ACME (`auto`). Single-route hosts are unchanged from
 * the pre-grouping behaviour; mixed hosts get a deterministic scheme.
 */
function resolveHostTls(routes: readonly DomainRoute[]): DomainRoute['tls'] {
  if (routes.some((r) => r.tls === 'custom')) return 'custom';
  if (routes.every((r) => r.tls === 'off')) return 'off';
  return 'auto';
}

/** Sort longest-prefix-first; the root `/` (a catch-all) always sorts last. */
function bySpecificity(a: DomainRoute, b: DomainRoute): number {
  const pa = routePath(a);
  const pb = routePath(b);
  const wa = pa === '/' ? 0 : pa.length;
  const wb = pb === '/' ? 0 : pb.length;
  if (wb !== wa) return wb - wa;
  // Stable, deterministic tie-break for equal-length paths.
  if (pa < pb) return -1;
  if (pa > pb) return 1;
  return 0;
}

function buildSite(host: string, routes: DomainRoute[], config: IngressConfig): string[] {
  const tls = resolveHostTls(routes);
  const address = tls === 'off' ? `http://${host}` : host;
  const out: string[] = [`${address} {`];

  if (tls === 'custom') {
    const certs = (config.globalOptions.extraConfig as Record<string, unknown>).certs as
      | Record<string, { cert: string; key: string }>
      | undefined;
    const material = certs?.[host];
    if (material) out.push(`  tls ${material.cert} ${material.key}`);
  } else if (config.globalOptions.onDemandTls && tls === 'auto') {
    out.push('  tls {', '    on_demand', '  }');
  }

  const ordered = [...routes].sort(bySpecificity);
  // The overwhelmingly common case — a single service at the host root — renders
  // WITHOUT a handle wrapper, byte-for-byte identical to the pre-grouping output.
  const only = ordered.length === 1 ? ordered[0] : undefined;
  const bareRoot = only !== undefined && routePath(only) === '/';
  for (const r of ordered) appendRoute(out, r, bareRoot);

  out.push('}');
  return out;
}

/**
 * The reverse_proxy directive(s) for a WARM route. A route carrying a `canary`
 * fragment emits both upstreams — stable FIRST, canary second — with
 * `lb_policy weighted_round_robin <stableWeight> <canaryWeight>`: Caddy assigns
 * the weights positionally, in upstream declaration order, so the order of the
 * two lists must always match (golden-tested).
 */
function warmProxy(r: DomainRoute): string[] {
  const c = r.canary;
  if (!c || c.weightPct <= 0) return [`reverse_proxy ${r.service}:${r.port}`];
  // Clamp + round: weighted_round_robin takes non-negative integer weights.
  const canaryWeight = Math.min(100, Math.max(0, Math.round(c.weightPct)));
  const stableWeight = 100 - canaryWeight;
  return [
    `reverse_proxy ${r.service}:${r.port} ${c.service}:${c.port} {`,
    `  lb_policy weighted_round_robin ${stableWeight} ${canaryWeight}`,
    '}',
  ];
}

/**
 * Emit one route's directives. `bare` (a host's only route, at the root) writes the
 * reverse_proxy / cold-rewrite straight into the site block; every other route is
 * wrapped in its own `handle`/`handle_path` so multiple services coexist on a host.
 *
 * Scale-to-zero COLD: the backing service is asleep, so the route rewrites to the
 * activator's wake endpoint and proxies the controller (server-side — the activator
 * host is internal). `return` carries the caller's original URL so the activator can
 * 307 the browser back once the service is warm. Only THIS route's path is diverted;
 * sibling routes on the same host stay direct (a cold `/api` never sleeps `/`).
 * A cold route ignores any canary fragment — waking the stable service comes first.
 */
function appendRoute(out: string[], r: DomainRoute, bare: boolean): void {
  const path = routePath(r);
  const body: string[] = r.cold
    ? [
        `rewrite * ${r.cold.wakePath}?return={scheme}://{host}{uri}`,
        `reverse_proxy ${r.cold.upstream}`,
      ]
    : warmProxy(r);

  if (bare) {
    for (const line of body) out.push(`  ${line}`);
    return;
  }

  if (path === '/') {
    // Catch-all (sorted last): everything not matched by a more specific handle.
    out.push('  handle {');
    for (const line of body) out.push(`    ${line}`);
    out.push('  }');
    return;
  }

  // A cold route always uses `handle` — the wake rewrite replaces the path, so
  // prefix stripping is moot; warm routes honour stripPathPrefix via handle_path.
  const directive = !r.cold && r.stripPathPrefix ? 'handle_path' : 'handle';
  out.push(`  ${directive} ${path}* {`);
  for (const line of body) out.push(`    ${line}`);
  out.push('  }');
}
