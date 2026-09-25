import * as React from 'react';
import { CodeView, curl, restExchange, toYaml, withHeader } from '@/components/calm';
import type { StackDomain } from '@/components/ingress/stack-domain-row';

type Yaml = Parameters<typeof toYaml>[0];

function protect(d: StackDomain): Record<string, Yaml> | undefined {
  const p = d.protection;
  if (!p) return undefined;
  const out: Record<string, Yaml> = {};
  if (p.rateLimit) out.rate_limit = `${p.rateLimit.requests}/${p.rateLimit.windowSeconds === 60 ? 'min' : p.rateLimit.windowSeconds === 1 ? 's' : 'hour'}`;
  if (p.ipAllow.length) out.ip_allow = p.ipAllow;
  if (p.ipDeny.length) out.ip_deny = p.ipDeny;
  if (p.countryAllow?.length) out.countries_allow = p.countryAllow;
  if (p.countryDeny?.length) out.countries_deny = p.countryDeny;
  if (p.blockBots) out.block_bots = true;
  if (p.bodyMaxSize) out.body_max = p.bodyMaxSize.toLowerCase();
  if (p.waf) out.waf = true;
  return Object.keys(out).length ? out : undefined;
}

/** Code depth of Domains: each service's `domains:` in swarmy.yaml, and the same routes over REST. */
export function DomainsCode({ stack, rows }: { stack: string; rows: StackDomain[] }): React.JSX.Element {
  const services: Record<string, { domains: Yaml[] }> = {};
  for (const d of rows.filter((r) => !r.auto)) {
    const svc = d.serviceName.startsWith(`${stack}_`) ? d.serviceName.slice(stack.length + 1) : d.serviceName;
    const p = protect(d);
    const entry: Yaml = p || (d.pathPrefix && d.pathPrefix !== '/') ? { host: d.host, path: d.pathPrefix ?? undefined, protect: p } : d.host;
    (services[svc] ??= { domains: [] }).domains.push(entry);
  }
  const first = rows[0];
  const rest = [
    restExchange('GET', '/ingress/domains', rows.map((d) => ({ host: d.host, service_id: d.serviceId, target_port: d.targetPort, tls: d.tls }))),
    '',
    '# add one',
    curl('POST', '/ingress/domains', { host: `www.${first?.host.replace(/^www\./, '') ?? 'example.com'}`, service_id: first?.serviceId ?? '<service id>', target_port: first?.targetPort ?? 3000, tls: 'auto' }),
  ].join('\n');
  return (
    <CodeView
      source="yaml"
      tabs={[
        { label: 'swarmy.yaml', code: withHeader(`swarmy.yaml · ${stack}'s addresses`, Object.keys(services).length ? toYaml({ services }) : '# no domains yet') },
        { label: 'REST', code: rest },
      ]}
    />
  );
}
