import type { DomainRoute, IngressConfig } from '../types';

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

    const middlewares = [...r.middlewares];
    if (r.stripPathPrefix && r.pathPrefix && r.pathPrefix !== '/') {
      const mw = `${rn}-strip`;
      labels[`traefik.http.middlewares.${mw}.stripprefix.prefixes`] = r.pathPrefix;
      middlewares.push(mw);
    }
    if (middlewares.length) labels[`traefik.http.routers.${rn}.middlewares`] = middlewares.join(',');
    byService.set(r.service, labels);
  }
  return byService;
}

/** Build a Traefik dynamic-config YAML (file provider). */
export function buildTraefikDynamicYaml(config: IngressConfig): string {
  const routers: string[] = [];
  const services: string[] = [];
  for (const r of config.domains) {
    const rn = routerName(r);
    let rule = `Host(\`${r.domain}\`)`;
    if (r.pathPrefix && r.pathPrefix !== '/') rule += ` && PathPrefix(\`${r.pathPrefix}\`)`;
    routers.push(`    ${rn}:`);
    routers.push(`      rule: "${rule}"`);
    routers.push(`      service: "${rn}"`);
    routers.push(`      entryPoints: ["${r.tls === 'off' ? 'web' : 'websecure'}"]`);
    if (r.tls === 'auto') {
      routers.push('      tls:');
      routers.push('        certResolver: le');
    }
    services.push(`    ${rn}:`);
    services.push('      loadBalancer:');
    services.push('        servers:');
    services.push(`          - url: "http://${r.service}:${r.port}"`);
  }
  return ['http:', '  routers:', ...routers, '  services:', ...services, ''].join('\n');
}
