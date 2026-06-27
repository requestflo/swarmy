import type { DomainRoute, IngressConfig } from '../types';

/**
 * nginx render (pure string construction). Emits a single `server { … }` block
 * per domain with a `location` per route. Unlike Caddy there is no automatic
 * HTTPS — nginx terminates TLS only when cert material is supplied (custom mode)
 * or when an external ACME companion drops certs at the conventional path. For
 * `tls: auto` we emit the conventional Let's-Encrypt cert path so a sidecar
 * (e.g. certbot / acme.sh) can manage issuance out of band.
 */

export const NGINX_CONFIG_PATH = '/etc/nginx/conf.d/swarmy.conf';

function certPaths(
  r: DomainRoute,
  config: IngressConfig,
): { cert: string; key: string } | undefined {
  if (r.tls === 'custom') {
    const certs = (config.globalOptions.extraConfig as Record<string, unknown>).certs as
      | Record<string, { cert: string; key: string }>
      | undefined;
    return certs?.[r.domain];
  }
  if (r.tls === 'auto') {
    // Conventional ACME companion layout. Cert issuance is out-of-band.
    return {
      cert: `/etc/letsencrypt/live/${r.domain}/fullchain.pem`,
      key: `/etc/letsencrypt/live/${r.domain}/privkey.pem`,
    };
  }
  return undefined;
}

function buildServer(r: DomainRoute, config: IngressConfig): string[] {
  const out: string[] = [];
  const upstream = `http://${r.service}:${r.port}`;
  const tls = certPaths(r, config);
  const listen = tls ? '443 ssl' : '80';

  out.push('server {');
  out.push(`  listen ${listen};`);
  out.push(`  server_name ${r.domain};`);
  if (tls) {
    out.push(`  ssl_certificate ${tls.cert};`);
    out.push(`  ssl_certificate_key ${tls.key};`);
  }
  const loc = r.pathPrefix && r.pathPrefix !== '/' ? r.pathPrefix : '/';
  out.push(`  location ${loc} {`);
  if (r.stripPathPrefix && loc !== '/') {
    // Trailing slash on proxy_pass strips the matched prefix.
    out.push(`    proxy_pass ${upstream}/;`);
  } else {
    out.push(`    proxy_pass ${upstream};`);
  }
  out.push('    proxy_set_header Host $host;');
  out.push('    proxy_set_header X-Real-IP $remote_addr;');
  out.push('    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
  out.push('    proxy_set_header X-Forwarded-Proto $scheme;');
  out.push('  }');
  out.push('}');
  return out;
}

/** Build the full nginx config (one server block per domain). */
export function buildNginxConfig(config: IngressConfig): string {
  const out: string[] = [];
  for (const r of config.domains) {
    out.push(...buildServer(r, config), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
