import * as React from 'react';
import { CodeView } from '@/components/calm';
import type { PrivateNetwork } from './use-private-network';

/**
 * The private network as code. Mesh settings have no REST or swarmy.yaml form
 * yet, so this is what swarmy sees (read-only), plus the NetBird client lines a
 * laptop runs (NetBird's own CLI).
 */
export function PrivateNetworkCode({ n }: { n: PrivateNetwork }): React.JSX.Element {
  const name = (id: string): string => n.nodes.find((x) => x.id === id)?.name ?? id;
  const live = JSON.stringify(
    {
      driver: n.driver,
      enabled: !!n.config?.enabled,
      controlPlane: n.config?.controlPlaneMode ?? null,
      managementUrl: n.config?.managementUrl ?? null,
      tokenConfigured: !!n.config?.tokenConfigured,
      servers: n.peers.map((p) => ({ server: name(p.nodeId), meshIp: p.meshIp, status: p.status })),
      people: n.people.map((p) => ({ device: p.device, meshIp: p.meshIp, connected: p.connected, stacks: p.stacks })),
    },
    null,
    2,
  );
  const url = n.config?.managementUrl ?? '<management url>';
  const laptop = [
    '# on a laptop (NetBird client)',
    'brew install netbirdio/tap/netbird-ui   # macOS',
    `netbird up --management-url ${url}`,
    'netbird status',
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'Live state', code: live },
        { label: 'Laptop', code: laptop },
      ]}
      source="readonly"
    />
  );
}
