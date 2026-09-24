import type { DomainRoute, IngressConfig } from '../types';
import type { HostRedirect } from '../www';
import {
  APP_AUTH_CONTROLLER_PREFIX,
  APP_AUTH_IDENTITY_HEADERS,
  APP_AUTH_ORIGINAL_URI_HEADER,
  APP_AUTH_PATH_PREFIX,
} from '../app-auth';

/**
 * Header hygiene for a login-protected route: blank every identity header a
 * client might forge (Traefik's `customRequestHeaders` with an empty value
 * DELETES the header). Traefik cannot wildcard-delete, so the known set is
 * listed; the forwardAuth step then sets them from the controller's answer.
 */
const STRIPPED_IDENTITY_HEADERS = [...APP_AUTH_IDENTITY_HEADERS, APP_AUTH_ORIGINAL_URI_HEADER];

function authMiddlewareNames(rn: string): { strip: string; auth: string } {
  return { strip: `${rn}-swarmy-strip`, auth: `${rn}-swarmy-auth` };
}

function forwardAuthAddress(r: DomainRoute): string {
  return `http://${r.auth!.upstream}${r.auth!.verifyPath}`;
}

function sanitize(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export function routerName(r: DomainRoute): string {
  const suffix = r.pathPrefix && r.pathPrefix !== '/' ? `-${r.pathPrefix}` : '';
  return sanitize(`${r.service}-${r.domain}${suffix}`);
}

/** Escape a hostname for a Traefik (Go RE2) regex. */
function reHost(host: string): string {
  return host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redirectRouterName(r: HostRedirect): string {
  return sanitize(`www-redirect-${r.from}`);
}

/**
 * The apex ↔ www redirects this render emits: an explicit route for `from`
 * wins (skipped), duplicates collapse. Each is a router on `Host(from)` whose
 * only job is a `redirectRegex` middleware (path + query kept, permanent)
 * bound to Traefik's built-in `noop@internal` service.
 */
function redirectsOf(config: IngressConfig): HostRedirect[] {
  const routed = new Set(config.domains.map((d) => d.domain));
  const out: HostRedirect[] = [];
  for (const r of config.hostRedirects ?? []) {
    if (routed.has(r.from) || out.some((x) => x.from === r.from)) continue;
    out.push(r);
  }
  return out;
}

function redirectRegex(r: HostRedirect): { regex: string; replacement: string } {
  return {
    regex: `^https?://${reHost(r.from)}(:[0-9]+)?(.*)$`,
    replacement: `${r.tls === 'off' ? 'http' : 'https'}://${r.to}\${2}`,
  };
}

/** Build per-service Traefik docker labels (labels provider). */
export function buildTraefikLabels(config: IngressConfig): Map<string, Record<string, string>> {
  const byService = new Map<string, Record<string, string>>();
  for (const r of config.domains) {
    const labels = byService.get(r.service) ?? { 'traefik.enable': 'true' };
    const rn = routerName(r);
    let rule = `Host(\`${r.domain}\`)`;
    if (r.pathPrefix && r.pathPrefix !== '/') rule += ` && PathPrefix(\`${r.pathPrefix}\`)`;
    labels[`traefik.http.routers.${rn}.rule`] = rule;
    labels[`traefik.http.routers.${rn}.entrypoints`] = r.tls === 'off' ? 'web' : 'websecure';
    if (r.tls === 'auto') labels[`traefik.http.routers.${rn}.tls.certresolver`] = 'le';
    labels[`traefik.http.services.${rn}.loadbalancer.server.port`] = String(r.port);

    // Login gate first (strip forged identity headers, then forward-auth), so
    // the controller sees the caller's original, un-stripped path.
    const middlewares: string[] = [];
    if (r.auth) {
      const mw = authMiddlewareNames(rn);
      STRIPPED_IDENTITY_HEADERS.forEach((h) => {
        labels[`traefik.http.middlewares.${mw.strip}.headers.customrequestheaders.${h}`] = '';
      });
      labels[`traefik.http.middlewares.${mw.auth}.forwardauth.address`] = forwardAuthAddress(r);
      labels[`traefik.http.middlewares.${mw.auth}.forwardauth.trustforwardheader`] = 'false';
      labels[`traefik.http.middlewares.${mw.auth}.forwardauth.authresponseheaders`] =
        APP_AUTH_IDENTITY_HEADERS.join(',');
      middlewares.push(mw.strip, mw.auth);
    }
    middlewares.push(...r.middlewares);
    if (r.stripPathPrefix && r.pathPrefix && r.pathPrefix !== '/') {
      const mw = `${rn}-strip`;
      labels[`traefik.http.middlewares.${mw}.stripprefix.prefixes`] = r.pathPrefix;
      middlewares.push(mw);
    }
    if (middlewares.length) labels[`traefik.http.routers.${rn}.middlewares`] = middlewares.join(',');
    byService.set(r.service, labels);
  }
  // Redirect routers ride on the label set of the service that serves the
  // canonical host (labels need a swarm service to live on); a redirect whose
  // destination has no route here has nowhere to live and is skipped.
  for (const r of redirectsOf(config)) {
    const owner = config.domains.find((d) => d.domain === r.to && !d.service.includes(':'));
    if (!owner) continue;
    const labels = byService.get(owner.service) ?? { 'traefik.enable': 'true' };
    const rn = redirectRouterName(r);
    const { regex, replacement } = redirectRegex(r);
    labels[`traefik.http.routers.${rn}.rule`] = `Host(\`${r.from}\`)`;
    labels[`traefik.http.routers.${rn}.entrypoints`] = r.tls === 'off' ? 'web' : 'websecure';
    if (r.tls !== 'off') labels[`traefik.http.routers.${rn}.tls.certresolver`] = 'le';
    labels[`traefik.http.routers.${rn}.service`] = 'noop@internal';
    labels[`traefik.http.routers.${rn}.middlewares`] = rn;
    labels[`traefik.http.middlewares.${rn}.redirectregex.regex`] = regex;
    labels[`traefik.http.middlewares.${rn}.redirectregex.replacement`] = replacement;
    labels[`traefik.http.middlewares.${rn}.redirectregex.permanent`] = 'true';
    byService.set(owner.service, labels);
  }
  return byService;
}

/** Build a Traefik dynamic-config YAML (file provider). */
export function buildTraefikDynamicYaml(config: IngressConfig): string {
  const routers: string[] = [];
  const services: string[] = [];
  const middlewares: string[] = [];
  for (const r of config.domains) {
    const rn = routerName(r);
    let rule = `Host(\`${r.domain}\`)`;
    if (r.pathPrefix && r.pathPrefix !== '/') rule += ` && PathPrefix(\`${r.pathPrefix}\`)`;
    routers.push(`    ${rn}:`);
    routers.push(`      rule: "${rule}"`);
    routers.push(`      service: "${rn}"`);
    routers.push(`      entryPoints: ["${r.tls === 'off' ? 'web' : 'websecure'}"]`);
    // Scale-to-zero COLD: a `replacePath` middleware rewrites the request to the
    // activator wake endpoint and the service points at the activator host. As with
    // HAProxy, the seamless 307 `return` bounce is Caddy/nginx-only; here the service
    // wakes and is served direct on the next (re-rendered) request.
    const chain: string[] = [];
    if (r.auth) {
      // "Protect my app": strip forged identity headers, then forward-auth
      // against the controller (a 302/401/403 answer is passed to the caller).
      const mw = authMiddlewareNames(rn);
      chain.push(mw.strip, mw.auth);
      middlewares.push(`    ${mw.strip}:`);
      middlewares.push('      headers:');
      middlewares.push('        customRequestHeaders:');
      for (const h of STRIPPED_IDENTITY_HEADERS) middlewares.push(`          ${h}: ""`);
      middlewares.push(`    ${mw.auth}:`);
      middlewares.push('      forwardAuth:');
      middlewares.push(`        address: "${forwardAuthAddress(r)}"`);
      middlewares.push('        trustForwardHeader: false');
      middlewares.push(
        `        authResponseHeaders: [${APP_AUTH_IDENTITY_HEADERS.map((h) => `"${h}"`).join(', ')}]`,
      );
    }
    if (r.cold) {
      const mw = `${rn}-wake`;
      chain.push(mw);
      middlewares.push(`    ${mw}:`);
      middlewares.push('      replacePath:');
      middlewares.push(`        path: "${r.cold.wakePath}"`);
    }
    if (chain.length) routers.push(`      middlewares: [${chain.map((m) => `"${m}"`).join(', ')}]`);
    if (r.tls === 'auto') {
      routers.push('      tls:');
      routers.push('        certResolver: le');
    }
    services.push(`    ${rn}:`);
    services.push('      loadBalancer:');
    services.push('        servers:');
    services.push(`          - url: "http://${r.cold ? r.cold.upstream : `${r.service}:${r.port}`}"`);
  }
  // App login callback, once per protected host: `/.swarmy/auth/*` → the
  // controller's `/_app-auth/*` with the Host kept (first-party cookie). The
  // longer rule outranks the host's own routers (Traefik's default priority).
  const callbackHosts = new Map<string, DomainRoute>();
  for (const r of config.domains) if (r.auth && !callbackHosts.has(r.domain)) callbackHosts.set(r.domain, r);
  for (const [host, r] of callbackHosts) {
    const rn = sanitize(`swarmy-auth-${host}`);
    routers.push(`    ${rn}:`);
    routers.push(`      rule: "Host(\`${host}\`) && PathPrefix(\`${APP_AUTH_PATH_PREFIX}/\`)"`);
    routers.push(`      service: "${rn}"`);
    routers.push(`      entryPoints: ["${r.tls === 'off' ? 'web' : 'websecure'}"]`);
    routers.push(`      middlewares: ["${rn}-path"]`);
    if (r.tls === 'auto') {
      routers.push('      tls:');
      routers.push('        certResolver: le');
    }
    services.push(`    ${rn}:`);
    services.push('      loadBalancer:');
    services.push('        passHostHeader: true');
    services.push('        servers:');
    services.push(`          - url: "http://${r.auth!.upstream}"`);
    middlewares.push(`    ${rn}-path:`);
    middlewares.push('      replacePathRegex:');
    middlewares.push(`        regex: '^${APP_AUTH_PATH_PREFIX.replace(/\./g, '\\.')}/(.*)'`);
    middlewares.push(`        replacement: '${APP_AUTH_CONTROLLER_PREFIX}/$1'`);
  }
  for (const r of redirectsOf(config)) {
    const rn = redirectRouterName(r);
    const { regex, replacement } = redirectRegex(r);
    routers.push(`    ${rn}:`);
    routers.push(`      rule: "Host(\`${r.from}\`)"`);
    routers.push('      service: "noop@internal"');
    routers.push(`      entryPoints: ["${r.tls === 'off' ? 'web' : 'websecure'}"]`);
    routers.push(`      middlewares: ["${rn}"]`);
    if (r.tls !== 'off') {
      routers.push('      tls:');
      routers.push('        certResolver: le');
    }
    middlewares.push(`    ${rn}:`);
    middlewares.push('      redirectRegex:');
    // Single-quoted YAML scalars: the regex's backslashes stay literal.
    middlewares.push(`        regex: '${regex}'`);
    middlewares.push(`        replacement: '${replacement}'`);
    middlewares.push('        permanent: true');
  }
  const out = ['http:', '  routers:', ...routers, '  services:', ...services];
  if (middlewares.length) out.push('  middlewares:', ...middlewares);
  out.push('');
  return out.join('\n');
}
