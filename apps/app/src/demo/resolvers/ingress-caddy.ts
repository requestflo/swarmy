import type { RouteProtection } from '@/components/ingress/protection-model';

/**
 * A route's protection lines for the demo Caddyfile (ingress-caddyfile.ts),
 * shaped like the real renderer's (packages/ingress render/caddyfile.ts
 * protectionLines): before the proxy, in the same order, with the same matcher
 * and zone names. Country rules render nothing, as for real without a GeoIP
 * database on the edge. A password renders after the rate limit, with the
 * hash hidden the way the real preview hides it.
 */
export interface ProtectedRoute {
  host: string;
  path: string | null;
  protection: RouteProtection | null;
}

const SCANNER_PATHS = ['/wp-login.php', '/.env*', '/.git/*', '/phpmyadmin*', '/vendor/phpunit/*', '/cgi-bin/*', '/wp-content/uploads/*.php'];

function key(r: ProtectedRoute): string {
  const raw = !r.path || r.path === '/' ? r.host : `${r.host}${r.path}`;
  return raw.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function protectionLines(r: ProtectedRoute): string[] {
  const p = r.protection;
  if (!p) return [];
  const k = key(r);
  const out: string[] = [];
  if (p.ipDeny.length) out.push(`@deny_${k} remote_ip ${p.ipDeny.join(' ')}`, `abort @deny_${k}`);
  if (p.ipAllow.length) out.push(`@notallowed_${k} {`, `  not remote_ip ${p.ipAllow.join(' ')}`, '}', `abort @notallowed_${k}`);
  if (p.blockBots) out.push(`@bots_${k} header_regexp User-Agent (?i)(bot|crawler|spider|scan)`, `abort @bots_${k}`);
  if (p.waf?.blockMethods.length) out.push(`@wafmeth_${k} method ${p.waf.blockMethods.join(' ')}`, `respond @wafmeth_${k} 403`);
  if (p.waf?.blockScannerPaths) out.push(`@wafscan_${k} path ${SCANNER_PATHS.join(' ')}`, `respond @wafscan_${k} 403`);
  p.requiredHeaders.forEach((h, i) => out.push(`@nohdr${i}_${k} {`, `  not header ${h.name} ${h.value ?? '*'}`, '}', `abort @nohdr${i}_${k}`));
  if (p.bodyMaxSize) out.push('request_body {', `  max_size ${p.bodyMaxSize}`, '}');
  const rl = p.rateLimit;
  if (rl) {
    const by = rl.key === 'header' && rl.header ? `{header.${rl.header}}` : '{remote_host}';
    out.push('rate_limit {', `  zone rl_${k} {`, `    key ${by}`, `    events ${rl.requests}`, `    window ${rl.windowSeconds}s`, '  }', '}');
  }
  const users = p.basicAuth?.users ?? [];
  if (users.length) out.push('basic_auth {', ...users.map((u) => `  ${u.username} <bcrypt hash, sealed in swarmy>`), '}');
  return out;
}
