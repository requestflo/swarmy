import { looksSecret, maskValue, type ServiceDetail } from '@swarmy/core';
import { curl, toYaml, withHeader, type CodeTab } from '@/components/calm';

/** The live spec as a compose service, and the REST calls behind this page's buttons. */
export function serviceCode(s: ServiceDetail): CodeTab[] {
  const env = Object.fromEntries(
    Object.entries(s.env).map(([k, v]) => [k, looksSecret(k, v) ? maskValue(v) : v]),
  );
  const spec = {
    services: {
      [s.name]: {
        image: s.image,
        ...(Object.keys(env).length ? { environment: env } : {}),
        ...(s.secretKeys && Object.keys(s.secretKeys).length ? { secrets: Object.keys(s.secretKeys) } : {}),
        ...(s.ports.length
          ? { ports: s.ports.map((p) => `${p.published ? `${p.published}:` : ''}${p.target}/${p.protocol}`) }
          : {}),
        ...(s.volumes.length ? { volumes: s.volumes.map((v) => `${v.source ?? ''}:${v.target}${v.readOnly ? ':ro' : ''}`) } : {}),
        networks: s.networks,
        deploy: {
          replicas: s.replicas.desired,
          ...(s.constraints.length ? { placement: { constraints: s.constraints } } : {}),
        },
      },
    },
  };
  const rest = [
    curl('GET', `/services/${s.id}`),
    '',
    curl('POST', `/services/${s.id}/scale`, { replicas: s.replicas.desired }),
    '',
    curl('POST', `/services/${s.id}/restart`),
    '',
    curl('GET', `/services/${s.id}/logs`),
  ].join('\n');
  const app = s.stackId ?? 'my-app';
  const cli = [`swarmy logs --app ${app} --service ${s.name} --follow`, `swarmy env ls --app ${app} --service ${s.name}`, `swarmy run --app ${app} --service ${s.name} -- sh`].join('\n');
  return [
    { label: 'compose', code: withHeader(`${s.name} — the live spec (secret-looking values masked)`, toYaml(spec)) },
    { label: 'REST', code: rest },
    { label: 'CLI', code: cli },
  ];
}
