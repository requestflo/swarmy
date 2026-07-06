import type {
  ControllerVhost,
  DomainRoute,
  IngressConfig,
  RegionUpstream,
  RouteProtection,
} from '../types';

/**
 * Curated scanner-path list backing `waf.blockScannerPaths` — the endpoints
 * every internet-facing host gets probed for within minutes. Caddy `path`
 * matcher patterns (globbed where a bare path would be uselessly exact).
 * Pinned by tests; extend deliberately — a wrong entry here 403s real traffic
 * on every WAF-enabled route at once.
 */
export const WAF_SCANNER_PATHS: readonly string[] = [
  '/wp-login.php',
  '/.env*',
  '/.git/*',
  '/phpmyadmin*',
  '/vendor/phpunit/*',
  '/cgi-bin/*',
  '/wp-content/uploads/*.php',
];

/** Does any route cache? (Cold routes never cache — the wake redirect must not stick.) */
function anyCached(config: IngressConfig): boolean {
  return config.domains.some((d) => d.protection?.cache && !d.cold);
}

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
  // Tracing runs first so its span wraps the whole request (incl. the proxy).
  if (config.globalOptions.tracing) global.push('  order tracing first');
  // Response caching (caddyserver/cache-handler — swarmy Caddy build only):
  // the nonstandard `cache` directive needs an explicit slot in Caddy's
  // directive order, and the bare global `cache` option provisions the module.
  // Per-route knobs (ttl/stale/key) live on each route's own cache block.
  if (anyCached(config)) {
    global.push('  order cache before rewrite');
    global.push('  cache');
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

  // Controller-upstream vhosts (status pages / inbound webhooks / AI gateway):
  // one site block per domain, rewriting `/` onto the controller path that
  // serves it, then proxying the controller. A vhost whose domain already has a
  // service route is SKIPPED — Caddy rejects duplicate site addresses, and the
  // service route (explicit user intent) wins.
  // Also dedupe vhosts against EACH OTHER (a status page and a webhook pointed
  // at the same hostname would otherwise emit two identical site addresses and
  // Caddy would reject the whole file). First wins; writers should prevent the
  // collision, the renderer must never produce an unloadable file.
  const routeHosts = new Set(config.domains.map((d) => d.domain));
  for (const v of config.controllerVhosts) {
    if (routeHosts.has(v.domain)) continue;
    routeHosts.add(v.domain);
    out.push(...buildControllerVhost(v), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/**
 * A controller-upstream vhost: the domain's path space is rewritten under
 * `targetPath` (`/` → `/s/my-page/`, `/foo` → `/s/my-page/foo`) and proxied to
 * the controller — the same dial target the scale-to-zero activator uses.
 * Status pages are SPA-rendered, so their asset requests (`/assets/*`) must
 * reach the controller unrewritten or the page shell loads but its bundle 404s.
 */
function buildControllerVhost(v: ControllerVhost): string[] {
  const address = v.tls === 'off' ? `http://${v.domain}` : v.domain;
  if (v.kind === 'status-page') {
    return [
      `${address} {`,
      `  # swarmy ${v.kind} vhost`,
      '  @spa not path /assets/*',
      `  rewrite @spa ${v.targetPath}{uri}`,
      `  reverse_proxy ${v.upstream}`,
      '}',
    ];
  }
  return [
    `${address} {`,
    `  # swarmy ${v.kind} vhost`,
    `  rewrite * ${v.targetPath}{uri}`,
    `  reverse_proxy ${v.upstream}`,
    '}',
  ];
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

  // Distributed tracing: one span per request through this host, exported over
  // OTLP by the controller (OTEL_* env). `order tracing first` (global options)
  // guarantees it wraps the proxy so the span covers the whole request.
  if (config.globalOptions.tracing) {
    out.push('  tracing {', '    span swarmy-edge', '  }');
  }

  const ordered = [...routes].sort(bySpecificity);
  // The overwhelmingly common case — a single service at the host root — renders
  // WITHOUT a handle wrapper, byte-for-byte identical to the pre-grouping output.
  const only = ordered.length === 1 ? ordered[0] : undefined;
  const bareRoot = only !== undefined && routePath(only) === '/';
  for (const r of ordered) appendRoute(out, r, bareRoot, config);

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
function warmProxy(r: DomainRoute, localRegion?: string): string[] {
  const c = r.canary;
  if (c && c.weightPct > 0) {
    // Canary wins over region ordering: weighted + first lb policies cannot
    // combine in one reverse_proxy (validate() warns on the overlap).
    // Clamp + round: weighted_round_robin takes non-negative integer weights.
    const canaryWeight = Math.min(100, Math.max(0, Math.round(c.weightPct)));
    const stableWeight = 100 - canaryWeight;
    return [
      `reverse_proxy ${r.service}:${r.port} ${c.service}:${c.port} {`,
      `  lb_policy weighted_round_robin ${stableWeight} ${canaryWeight}`,
      '}',
    ];
  }
  if (r.regionUpstreams && r.regionUpstreams.length > 0) {
    // Geo-edge: ordered multi-upstream — the receiving node's region first,
    // the rest as failover. `lb_policy first` always dials the first AVAILABLE
    // upstream; passive health (max_fails/fail_duration) shifts traffic to the
    // next region for 30s when local tasks die, and lb_try_* retries within a
    // request so a dying local task doesn't 502 the caller.
    const ordered = orderByRegion(r.regionUpstreams, localRegion);
    return [
      `reverse_proxy ${ordered.map((u) => `${u.service}:${u.port}`).join(' ')} {`,
      '  lb_policy first',
      '  lb_try_duration 3s',
      '  lb_try_interval 250ms',
      '  fail_duration 30s',
      '  max_fails 2',
      '}',
    ];
  }
  return [`reverse_proxy ${r.service}:${r.port}`];
}

/** Local region first; the rest in stable name order (deterministic output). */
function orderByRegion(ups: readonly RegionUpstream[], local?: string): RegionUpstream[] {
  return [...ups].sort((a, b) => {
    if (a.region !== b.region) {
      if (a.region === local) return -1;
      if (b.region === local) return 1;
      return a.region < b.region ? -1 : 1;
    }
    return a.service < b.service ? -1 : a.service > b.service ? 1 : 0;
  });
}

/**
 * A stable, Caddy-identifier-safe key for one route — names its rate-limit zone
 * and protection matchers. Derived from host+path only, so the SAME route keeps
 * the same zone across re-renders (sliding-window counters survive reloads).
 */
function routeKey(r: DomainRoute): string {
  const path = routePath(r);
  const raw = path === '/' ? r.domain : `${r.domain}${path}`;
  return raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

/**
 * Edge-protection directives for one route, emitted BEFORE its proxy body so a
 * blocked request never reaches the upstream. Order: IP deny → IP allow →
 * country deny → country allow → bot block → WAF-lite → required headers →
 * body cap → rate limit (mholt/caddy-ratelimit — needs the swarmy Caddy build,
 * see docker/caddy-swarmy) → cache. Matcher names carry the route key so
 * sibling routes on one host never collide.
 */
function protectionLines(r: DomainRoute, geoipMmdbPath?: string): string[] {
  const p: RouteProtection | undefined = r.protection;
  if (!p) return [];
  const key = routeKey(r);
  const out: string[] = [];
  if (p.ipDeny.length > 0) {
    out.push(`@deny_${key} remote_ip ${p.ipDeny.join(' ')}`, `abort @deny_${key}`);
  }
  if (p.ipAllow.length > 0) {
    out.push(
      `@notallowed_${key} {`,
      `  not remote_ip ${p.ipAllow.join(' ')}`,
      '}',
      `abort @notallowed_${key}`,
    );
  }
  // Country rules (porech/caddy-maxmind-geolocation — swarmy Caddy build only).
  // Without a configured mmdb path the matcher would fail EVERY request open or
  // closed at Caddy's whim, so we render NOTHING and validate() warns instead.
  // Deny before allow, mirroring the IP rules: deny wins on overlap.
  if (geoipMmdbPath) {
    if (p.countryDeny && p.countryDeny.length > 0) {
      out.push(
        `@geodeny_${key} {`,
        '  maxmind_geolocation {',
        `    db_path ${geoipMmdbPath}`,
        // allow_countries = "match requests FROM these countries" — the abort
        // below is what makes it a deny (the module's own deny_* keys match the
        // complement, which would need double negation here).
        `    allow_countries ${p.countryDeny.join(' ')}`,
        '  }',
        '}',
        `abort @geodeny_${key}`,
      );
    }
    if (p.countryAllow && p.countryAllow.length > 0) {
      out.push(
        `@geonotallowed_${key} {`,
        '  not maxmind_geolocation {',
        `    db_path ${geoipMmdbPath}`,
        `    allow_countries ${p.countryAllow.join(' ')}`,
        '  }',
        '}',
        `abort @geonotallowed_${key}`,
      );
    }
  }
  if (p.blockBots) {
    out.push(
      `@bots_${key} header_regexp User-Agent (?i)(bot|crawler|spider|scan)`,
      `abort @bots_${key}`,
    );
  }
  // WAF-lite: plain matchers + 403, no plugin. This tier is deliberately thin —
  // the escalation path for real rule-set inspection is Coraza (OWASP CRS),
  // NOT more patterns here. 403 (respond) rather than abort: scanners treat a
  // dropped connection as "retry", a status code as an answer.
  const waf = p.waf;
  if (waf) {
    if (waf.blockMethods.length > 0) {
      out.push(`@wafmeth_${key} method ${waf.blockMethods.join(' ')}`, `respond @wafmeth_${key} 403`);
    }
    if (waf.blockScannerPaths) {
      out.push(`@wafscan_${key} path ${WAF_SCANNER_PATHS.join(' ')}`, `respond @wafscan_${key} 403`);
    }
    waf.denyQueryPatterns.forEach((pattern, i) => {
      const m = `@wafq${i}_${key}`;
      // Backtick-quoted CEL expression; the schema rejects patterns carrying
      // backticks or double quotes so this token can never be broken out of.
      out.push(
        `${m} expression \`{http.request.uri.query}.matches("${pattern}")\``,
        `respond ${m} 403`,
      );
    });
  }
  p.requiredHeaders.forEach((h, i) => {
    const m = `@nohdr${i}_${key}`;
    out.push(`${m} {`, `  not header ${h.name} ${h.value ?? '*'}`, '}', `abort ${m}`);
  });
  if (p.bodyMaxSize) {
    out.push('request_body {', `  max_size ${p.bodyMaxSize}`, '}');
  }
  const rl = p.rateLimit;
  if (rl) {
    const keyExpr = rl.key === 'header' && rl.header ? `{header.${rl.header}}` : '{remote_host}';
    out.push(
      'rate_limit {',
      `  zone rl_${key} {`,
      `    key ${keyExpr}`,
      `    events ${rl.requests}`,
      `    window ${rl.windowSeconds}s`,
      '  }',
      '}',
    );
  }
  // Response cache (caddyserver/cache-handler — swarmy Caddy build only), last:
  // a request must clear every gate above before it can hit or fill the cache.
  // Cold routes never cache — the body is the activator's wake redirect.
  const cache = p.cache;
  if (cache && !r.cold) {
    out.push('cache {', `  ttl ${cache.ttlSeconds}s`);
    if (cache.staleWhileRevalidateSeconds !== undefined) {
      out.push(`  stale ${cache.staleWhileRevalidateSeconds}s`);
    }
    if (cache.keyHeaders && cache.keyHeaders.length > 0) {
      out.push('  key {', `    headers ${cache.keyHeaders.join(' ')}`, '  }');
    }
    out.push('}');
  }
  return out;
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
function appendRoute(out: string[], r: DomainRoute, bare: boolean, config: IngressConfig): void {
  const path = routePath(r);
  const extra = config.globalOptions.extraConfig as Record<string, unknown>;
  const geoipMmdbPath = typeof extra.geoipMmdbPath === 'string' ? extra.geoipMmdbPath : undefined;
  // Protections run first so a blocked request never reaches the upstream —
  // and never wakes a cold service.
  const body: string[] = [
    ...protectionLines(r, geoipMmdbPath),
    ...(r.cold
      ? [
          `rewrite * ${r.cold.wakePath}?return={scheme}://{host}{uri}`,
          `reverse_proxy ${r.cold.upstream}`,
        ]
      : warmProxy(r, config.localRegion)),
  ];

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
