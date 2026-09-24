import type { DomainRoute, IngressConfig } from '../types';
import type { HostRedirect } from '../www';

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

  // Scale-to-zero COLD: route the whole vhost to the controller activator. The
  // `rewrite ... break` replaces the request URI with the wake path + a `return`
  // of the caller's original URL, and `proxy_pass` (no URI part → the rewritten URI
  // is forwarded as-is) dials the activator. The host is a literal so no `resolver`
  // is required. The activator wakes the service then 307s the caller back.
  if (r.cold) {
    out.push('  location / {');
    out.push(`    rewrite ^ ${r.cold.wakePath}?return=$scheme://$host$request_uri break;`);
    out.push('    proxy_set_header Host $host;');
    out.push('    proxy_set_header X-Real-IP $remote_addr;');
    out.push('    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;');
    out.push('    proxy_set_header X-Forwarded-Proto $scheme;');
    out.push(`    proxy_pass http://${r.cold.upstream};`);
    out.push('  }');
    out.push('}');
    return out;
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

/**
 * A redirect-only server (apex ↔ www toggle): 308 to the canonical host with
 * the path + query kept (`$request_uri`). The redirect host needs its own cert
 * (the browser handshakes before it sees the redirect) — same layout as a
 * route: custom material when supplied for `from`, else the ACME-companion path.
 */
function buildRedirectServer(r: HostRedirect, config: IngressConfig): string[] {
  const scheme = r.tls === 'off' ? 'http' : 'https';
  let tls: { cert: string; key: string } | undefined;
  if (r.tls !== 'off') {
    const asRoute = { domain: r.from, tls: 'custom' } as DomainRoute;
    tls = (r.tls === 'custom' ? certPaths(asRoute, config) : undefined) ??
      certPaths({ ...asRoute, tls: 'auto' }, config);
  }
  const out = ['server {', `  listen ${tls ? '443 ssl' : '80'};`, `  server_name ${r.from};`];
  if (tls) out.push(`  ssl_certificate ${tls.cert};`, `  ssl_certificate_key ${tls.key};`);
  out.push('  # swarmy www redirect', `  return 308 ${scheme}://${r.to}$request_uri;`, '}');
  return out;
}

/** Build the full nginx config (one server block per domain, then redirects). */
export function buildNginxConfig(config: IngressConfig): string {
  const out: string[] = [];
  const hosts = new Set<string>();
  for (const r of config.domains) {
    hosts.add(r.domain);
    out.push(...buildServer(r, config), '');
  }
  // Apex ↔ www redirects; a host that also has a route is skipped (explicit wins).
  for (const r of config.hostRedirects ?? []) {
    if (hosts.has(r.from)) continue;
    hosts.add(r.from);
    out.push(...buildRedirectServer(r, config), '');
  }
  return `${out.join('\n').trimEnd()}\n`;
}
