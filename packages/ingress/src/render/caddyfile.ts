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

  for (const route of config.domains) {
    out.push(...buildSite(route, config), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

function buildSite(r: DomainRoute, config: IngressConfig): string[] {
  const address = r.tls === 'off' ? `http://${r.domain}` : r.domain;
  const out: string[] = [`${address} {`];

  if (r.tls === 'custom') {
    const certs = (config.globalOptions.extraConfig as Record<string, unknown>).certs as
      | Record<string, { cert: string; key: string }>
      | undefined;
    const material = certs?.[r.domain];
    if (material) out.push(`  tls ${material.cert} ${material.key}`);
  } else if (config.globalOptions.onDemandTls && r.tls === 'auto') {
    out.push('  tls {', '    on_demand', '  }');
  }

  // Scale-to-zero COLD: the backing service is asleep. Rewrite the request to the
  // activator's wake endpoint and reverse_proxy to the controller (server-side —
  // the activator host is internal). `return` carries the caller's original URL so
  // the activator can 307 the browser back once the service is warm. The whole site
  // routes to the activator regardless of pathPrefix (we'll be warm again next hit).
  if (r.cold) {
    out.push(`  rewrite * ${r.cold.wakePath}?return={scheme}://{host}{uri}`);
    out.push(`  reverse_proxy ${r.cold.upstream}`);
    out.push('}');
    return out;
  }

  const upstream = `${r.service}:${r.port}`;
  if (r.pathPrefix && r.pathPrefix !== '/') {
    const directive = r.stripPathPrefix ? 'handle_path' : 'handle';
    out.push(`  ${directive} ${r.pathPrefix}* {`, `    reverse_proxy ${upstream}`, '  }');
  } else {
    out.push(`  reverse_proxy ${upstream}`);
  }
  out.push('}');
  return out;
}
