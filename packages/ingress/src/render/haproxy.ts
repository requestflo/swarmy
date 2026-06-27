import type { IngressConfig } from '../types';

/**
 * HAProxy render (pure string construction). Emits a single frontend that
 * SNI/Host-routes to a backend per domain. TLS is terminated on the `https`
 * frontend when a combined PEM (cert+key) is supplied (custom mode) or via the
 * conventional `/etc/haproxy/certs` directory an external ACME companion fills.
 *
 * HAProxy has no built-in ACME, so `tls: auto` points the bind at the cert
 * directory and leaves issuance to a sidecar; `tls: off` serves plain HTTP.
 */

export const HAPROXY_CONFIG_PATH = '/etc/haproxy/haproxy.cfg';
const CERT_DIR = '/etc/haproxy/certs';

function sanitize(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

function backendName(domain: string): string {
  return `be_${sanitize(domain)}`;
}

/** Build the full haproxy.cfg. Deterministic for golden tests. */
export function buildHaproxyConfig(config: IngressConfig): string {
  const out: string[] = [];

  out.push('global');
  out.push('  log stdout format raw local0');
  out.push('  maxconn 4096');
  out.push('');
  out.push('defaults');
  out.push('  mode http');
  out.push('  timeout connect 5s');
  out.push('  timeout client 50s');
  out.push('  timeout server 50s');
  out.push('  option forwardfor');
  out.push('  option httplog');
  out.push('');

  const anyTls = config.domains.some((d) => d.tls !== 'off');
  const anyPlain = config.domains.some((d) => d.tls === 'off');

  if (anyPlain) {
    out.push('frontend http_in');
    out.push('  bind *:80');
    for (const r of config.domains) {
      if (r.tls !== 'off') continue;
      out.push(`  use_backend ${backendName(r.domain)} if { hdr(host) -i ${r.domain} }`);
    }
    out.push('');
  }

  if (anyTls) {
    out.push('frontend https_in');
    out.push(`  bind *:443 ssl crt ${CERT_DIR}`);
    out.push('  http-request set-header X-Forwarded-Proto https');
    for (const r of config.domains) {
      if (r.tls === 'off') continue;
      out.push(`  use_backend ${backendName(r.domain)} if { ssl_fc_sni -i ${r.domain} }`);
    }
    out.push('');
  }

  for (const r of config.domains) {
    out.push(`backend ${backendName(r.domain)}`);
    if (r.stripPathPrefix && r.pathPrefix && r.pathPrefix !== '/') {
      out.push(`  http-request replace-path ${r.pathPrefix}(.*) \\1`);
    }
    out.push(`  server srv ${r.service}:${r.port}`);
    out.push('');
  }

  return `${out.join('\n').trimEnd()}\n`;
}

export const HAPROXY_CERT_DIR = CERT_DIR;
