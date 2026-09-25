import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import type { FleetServer } from './use-fleet';

/**
 * The Servers page as REST: the list swarmy is showing (GET /nodes) and the
 * calls behind the inspector's buttons. Every path is in openapi.json.
 */
export function ServersCode({
  servers,
  selected,
}: {
  servers: FleetServer[];
  selected: FleetServer | null;
}): React.JSX.Element {
  const list = restExchange('GET', '/nodes', {
    data: servers.map(({ node: n }) => ({
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      role: n.role,
      status: n.status === 'degraded' ? 'online' : n.status,
      engine_version: n.engineVersion,
      os: n.os,
      arch: n.arch,
      last_seen_at: n.lastSeenAt,
    })),
    next_cursor: null,
  });
  const id = selected?.node.id ?? '{id}';
  const actions = [
    `# ${selected?.node.name ?? 'a server'}: details, empty it, take it back, label it, remove it`,
    curl('GET', `/nodes/${id}`),
    '',
    curl('POST', `/nodes/${id}/drain`),
    '',
    curl('POST', `/nodes/${id}/uncordon`),
    '',
    curl('PUT', `/nodes/${id}/labels`, { labels: { zone: 'eu-west' } }),
    '',
    curl('DELETE', `/nodes/${id}`),
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'REST', code: list },
        { label: 'actions', code: actions },
      ]}
      source="readonly"
      note="What swarmy sees right now. The same calls work with an API key, the SDKs and Terraform."
    />
  );
}
