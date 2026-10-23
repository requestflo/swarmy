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
}

function proxy(r: DemoCaddyRoute, pad: string): string[] {
  const guard = protectionLines({ host: r.host, path: r.pathPrefix, protection: r.protection ?? null }).map((l) => `${pad}${l}`);
  return [...guard, ...upstream(r, pad)];
}

function upstream(r: DemoCaddyRoute, pad: string): string[] {
  const up = `${r.stack}_${r.service}:${r.port}`;
  if (r.canaryPct) {
    const w = Math.round(r.canaryPct);
    return [`${pad}reverse_proxy ${up} ${r.stack}_${r.service}-canary:${r.port} {`, `${pad}  lb_policy weighted_round_robin ${100 - w} ${w}`, `${pad}  stream_close_delay 5m`, `${pad}}`];
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

export function demoCaddyfile(o: { routes: DemoCaddyRoute[]; onDemand: boolean; askUrl: string | null; sharedCerts: boolean }): string {
  const global = ['  metrics {', '    per_host', '  }'];
  if (o.onDemand) global.push('  on_demand_tls {', ...(o.askUrl ? [`    ask ${o.askUrl}`] : []), '  }');
  if (o.sharedCerts) {
    global.push('  storage swarmy {', '    replica s3 {', '      endpoint http://swarmy-garage:3900', '      bucket swarmy-edge-certs', '      region garage', '      prefix org-demo', '      import /run/secrets/swarmy-edge-certs-key', '      use_path_style true', '    }', '  }');
  }
  const out = ['{', ...global, '}', ''];
  const byHost = new Map<string, DemoCaddyRoute[]>();
  for (const r of o.routes.filter((x) => !x.gated)) byHost.set(r.host, [...(byHost.get(r.host) ?? []), r]);
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
