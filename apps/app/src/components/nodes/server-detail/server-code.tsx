import * as React from 'react';
import type { NodeDetail } from '@swarmy/core';
import { CodeView, curl, restExchange } from '@/components/calm';

/** One server as REST: what GET /nodes/{id} returns, and the calls behind its buttons. */
export function ServerCode({ node: n }: { node: NodeDetail }): React.JSX.Element {
  const get = restExchange('GET', `/nodes/${n.id}`, {
    id: n.id,
    name: n.name,
    hostname: n.hostname,
    role: n.role,
    status: n.status === 'degraded' ? 'online' : n.status,
    engine_version: n.engineVersion,
    os: n.os,
    arch: n.arch,
    last_seen_at: n.lastSeenAt,
  });
  const labels = Object.fromEntries(Object.entries(n.labels).filter(([k]) => !k.startsWith('swarmy.')));
  const actions = [
    `# ${n.name}: label it, empty it, take work again, remove it`,
    curl('PUT', `/nodes/${n.id}/labels`, { labels }),
    '',
    curl('POST', `/nodes/${n.id}/drain`),
    '',
    curl('POST', `/nodes/${n.id}/uncordon`),
    '',
    curl('DELETE', `/nodes/${n.id}`),
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'REST', code: get },
        { label: 'actions', code: actions },
      ]}
      source="readonly"
      note="What swarmy sees right now. The same calls work with an API key, the SDKs and Terraform."
    />
  );
}
