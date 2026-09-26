import * as React from 'react';
import type { InvService } from '@swarmy/core';
import { CodeView, curl } from '@/components/calm';
import type { DeployDomain } from './deploy-steps';

/**
 * Code depth for a deploy in flight: how to watch the same thing from a
 * terminal. Only real surfaces — `swarmy logs -f` (apps/cli) and the public
 * REST paths the tracker's signals map to (GET /stacks/{id}, /services,
 * /ingress/domains/{id}/status, /services/{id}/logs/stream).
 */
export function DeployingCode({
  stackId,
  service,
  domain,
}: {
  stackId: string | null;
  service: InvService | null;
  domain: DeployDomain | null;
}): React.JSX.Element {
  const svcId = service?.id ?? '<service-id>';
  const rest = [
    stackId ? `# The app and its status\n${curl('GET', `/stacks/${stackId}`)}` : null,
    `# Its services, with replicas running / desired\n${curl('GET', '/services')}`,
    domain ? `# The address: DNS and the HTTPS certificate\n${curl('GET', `/ingress/domains/${encodeURIComponent(domain.id)}/status`)}` : null,
    `# Follow its logs (Server-Sent Events)\n${curl('GET', `/services/${svcId}/logs/stream`).replace('curl -X GET', 'curl -N -X GET')}`,
  ].filter(Boolean);
  const cli = [
    '# Follow the new service’s logs as it starts',
    `swarmy logs ${service?.name ?? '<service>'} -f`,
  ].join('\n');
  return (
    <CodeView
      title="Watch it from a terminal"
      tabs={[
        { label: 'CLI', code: cli },
        { label: 'REST', code: rest.join('\n\n') },
      ]}
      source="readonly"
      note="Read-only: the same signals this page is watching, over the public API and the swarmy CLI."
    />
  );
}
