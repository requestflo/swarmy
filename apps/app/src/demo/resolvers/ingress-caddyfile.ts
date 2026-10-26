/**
 * The demo's Caddyfile, shaped like packages/ingress/src/render/caddyfile.ts
 * renders it: global options (per-host metrics, on-demand TLS with its ask
 * address, the credential-free `storage swarmy` replica on edge-per-node),
 * then one site block per host. A domain still waiting for DNS is withheld,
 * exactly as the controller's DNS gate does; the www companion gets its 308 site.
 * Each route's protections come before its proxy (ingress-caddy.ts).
 */
import type { RouteProtection } from '@/components/ingress/protection-model';
import { protectionLines } from './ingress-caddy';

export interface DemoCaddyRoute {
  host: string;
  stack: string;
  service: string;
  port: number;
  tls: string;
  pathPrefix: string | null;
  canaryPct: number | null;
  www?: string | null;
  /** Withheld until its DNS verifies. */
  gated: boolean;
  protection?: RouteProtection | null;
  /** Demo-only: the app has a copy in each of these regions (`${service}-${region}` siblings). */
  regions?: string[];
}

function proxy(r: DemoCaddyRoute, pad: string): string[] {
  const inner = [...protectionLines({ host: r.host, path: r.pathPrefix, protection: r.protection ?? null }), ...upstream(r, '')];
  // A password route keeps its literal order in one `route` block, as the real renderer does.
  const body = r.protection?.basicAuth?.users.length ? ['route {', ...inner.map((l) => `  ${l}`), '}'] : inner;
  return body.map((l) => `${pad}${l}`);
}

function upstream(r: DemoCaddyRoute, pad: string): string[] {
  const up = `${r.stack}_${r.service}:${r.port}`;
  if (r.canaryPct) {
    const w = Math.round(r.canaryPct);
    return [`${pad}reverse_proxy ${up} ${r.stack}_${r.service}-canary:${r.port} {`, `${pad}  lb_policy weighted_round_robin ${100 - w} ${w}`, `${pad}  stream_close_delay 5m`, `${pad}}`];
  }
  if (r.regions?.length) {
    // Region copies, already in this edge's order (its own region first), as the real renderer dials them.
    const ups = r.regions.map((g) => `${r.stack}_${r.service}-${g}:${r.port}`).join(' ');
    const lb = ['lb_policy first', 'lb_try_duration 3s', 'lb_try_interval 250ms', 'fail_duration 30s', 'max_fails 2', 'stream_close_delay 5m'];
    return [`${pad}reverse_proxy ${ups} {`, ...lb.map((l) => `${pad}  ${l}`), `${pad}}`];
  }
  return [`${pad}reverse_proxy ${up} {`, `${pad}  stream_close_delay 5m`, `${pad}}`];
}

function site(host: string, routes: DemoCaddyRoute[], onDemand: boolean): string[] {
  const tls = routes[0]!.tls;
  const out = [`${tls === 'off' ? `http://${host}` : host} {`];
  if (onDemand && tls === 'auto') out.push('  tls {', '    on_demand', '  }');
  const bare = routes.length === 1 && !routes[0]!.pathPrefix;
  for (const r of [...routes].sort((a, b) => (b.pathPrefix ?? '').length - (a.pathPrefix ?? '').length)) {
    if (bare) out.push(...proxy(r, '  '));
    else out.push(`  handle ${r.pathPrefix ? `${r.pathPrefix}* ` : ''}{`, ...proxy(r, '    '), '  }');
  }
  out.push('}');
  return out;
}

function companion(host: string): string {
  return host.startsWith('www.') ? host.slice(4) : `www.${host}`;
}

/** The receiving edge's region first, the rest by name (packages/ingress `orderByRegion`). */
function byRegion(regions: string[], local?: string): string[] {
  return [...regions].sort((a, b) => (a === local ? -1 : b === local ? 1 : a < b ? -1 : 1));
}

export function demoCaddyfile(o: {
  routes: DemoCaddyRoute[];
  onDemand: boolean;
  askUrl: string | null;
  sharedCerts: boolean;
  /** The edge this file is for; region copies list its region first. */
  localRegion?: string;
}): string {
  const global = ['  metrics {', '    per_host', '  }'];
  if (o.onDemand) global.push('  on_demand_tls {', ...(o.askUrl ? [`    ask ${o.askUrl}`] : []), '  }');
  if (o.sharedCerts) {
    global.push('  storage swarmy {', '    replica s3 {', '      endpoint http://swarmy-garage:3900', '      bucket swarmy-edge-certs', '      region garage', '      prefix org-demo', '      import /run/secrets/swarmy-edge-certs-key', '      use_path_style true', '    }', '  }');
  }
  const out = ['{', ...global, '}', ''];
  const byHost = new Map<string, DemoCaddyRoute[]>();
  for (const raw of o.routes.filter((x) => !x.gated)) {
    const r = raw.regions ? { ...raw, regions: byRegion(raw.regions, o.localRegion) } : raw;
    byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
  }
  for (const [host, routes] of byHost) {
    out.push(...site(host, routes, o.onDemand), '');
    const www = routes.find((r) => r.www)?.www;
    if (www && www !== 'serve-both') {
      const from = www === 'redirect-www-to-apex' ? companion(host) : host;
      const to = www === 'redirect-www-to-apex' ? host : companion(host);
      if (from !== host) out.push(`${from} {`, `  redir https://${to}{uri} 308`, '}', '');
    }
  }
  if (byHost.size === 0) out.push('# no domains routed yet');
  return out.join('\n').trimEnd();
}
