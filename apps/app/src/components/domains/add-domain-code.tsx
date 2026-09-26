import * as React from 'react';
import { CodeView, Tech, curl, toYaml, withHeader } from '@/components/calm';
import type { DomainPlan } from '@/components/ingress/domain-state';
import type { AddForm } from './use-add-domain';
import type { Target } from './use-add-targets';
import { normalizeHost } from './host-shape';

/** Code depth of "Add a domain": the same add + check over REST, and the swarmy.yaml form. */
export function AddDomainCode({ form, target }: { form: AddForm; target: Target | null }): React.JSX.Element {
  const host = normalizeHost(form.host) || 'shop.example.com';
  const serviceId = target?.serviceId ?? '<service id>';
  const path = form.path.trim() && form.path.trim() !== '/' ? form.path.trim() : undefined;
  const body = {
    host,
    service_id: serviceId,
    target_port: form.port,
    tls: form.tls,
    ...(path ? { path_prefix: path } : {}),
    ...(form.www !== 'none' ? { www: form.www } : {}),
  };
  const id = encodeURIComponent(`${serviceId}:${host}${path ?? ''}`);
  const rest = [
    '# add the domain',
    curl('POST', '/ingress/domains', body),
    '',
    '# check DNS (and the certificate) now',
    curl('POST', `/ingress/domains/${id}/verify`),
    '',
    '# follow it: waiting_dns → verified → issuing → active',
    curl('GET', `/ingress/domains/${id}/status`),
  ].join('\n');
  const entry = path ? { host, path } : host;
  const extras = [
    form.www !== 'none' ? '# the www pairing is a dashboard setting; swarmy.yaml has no key for it' : null,
    form.tls !== 'auto' ? `# tls ${form.tls} is a dashboard setting; swarmy.yaml has no key for it` : null,
  ].filter((x): x is string => x !== null);
  const yaml = withHeader(
    `swarmy.yaml · ${target?.stack ?? 'your app'}`,
    [...extras, toYaml({ services: { [target?.name ?? 'web']: { domains: [entry] } } })].join('\n'),
  );
  return (
    <CodeView
      title="Adding this domain as code"
      note="A dashboard setting. The same calls work over REST, and Terraform has it as swarmy_domain. There is no CLI command for domains."
      tabs={[
        { label: 'REST', code: rest },
        { label: 'swarmy.yaml', code: yaml },
      ]}
    />
  );
}

/** Controls depth: the edges the records point at. */
export function EdgeTech({ plan }: { plan: DomainPlan | null }): React.JSX.Element | null {
  if (!plan) return null;
  return (
    <Tech>
      edges ·{' '}
      {plan.edges.length
        ? plan.edges.map((e) => `${e.name ?? 'edge'} ${e.ip}${e.region ? ` (${e.region})` : ''}`).join(' · ')
        : 'no public IP known yet'}
    </Tech>
  );
}
