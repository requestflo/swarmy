import * as React from 'react';
import { CodeView, curl, restExchange, toYaml } from '@/components/calm';
import type { HubDomain } from './use-network';

/** The Domains page as code: each app's swarmy.yaml domains, and the same list over REST. */
export function NetworkCode({
  domains,
  zones,
}: {
  domains: HubDomain[];
  zones: Array<{ zone: string; mode: string }>;
}): React.JSX.Element {
  const apps = [...new Set(domains.map((d) => d.stack))];
  const yaml = apps
    .map((app) => {
      const services: Record<string, { domains: Array<{ host: string; path?: string }> }> = {};
      for (const d of domains.filter((x) => x.stack === app && !x.auto)) {
        (services[d.serviceName] ??= { domains: [] }).domains.push({
          host: d.host,
          ...(d.pathPrefix ? { path: d.pathPrefix } : {}),
        });
      }
      return `# ${app}/swarmy.yaml\n${toYaml({ app, services })}`;
    })
    .join('\n\n');
  const rest = restExchange('GET', '/ingress/domains', {
    data: domains.map((d) => ({
      id: d.id,
      host: d.host,
      service_name: d.serviceName,
      target_port: d.targetPort,
      tls: d.tls,
      path_prefix: d.pathPrefix,
      auto: !!d.auto,
    })),
    next_cursor: null,
  });
  const add = curl('POST', '/ingress/domains', { host: 'docs.example.com', service_id: '<service id>', target_port: 3000, tls: 'auto' });
  const dns = restExchange('GET', '/dns/zones', { data: zones.map((z) => ({ zone: z.zone, mode: z.mode })), next_cursor: null });
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: yaml || '# no domains yet' },
        { label: 'REST', code: `${rest}\n\n# add one\n${add}` },
        { label: 'DNS zones', code: dns },
      ]}
      note="Domains live in each app's swarmy.yaml (services.<name>.domains); saving opens a pull request. The same list works over REST."
    />
  );
}
