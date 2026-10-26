import * as React from 'react';
import { CodeView } from '@/components/calm';
import type { MeshLinkLike } from './mesh-link-words';
import type { PrivateNetwork } from './use-private-network';

/**
 * The private network as code. Mesh settings have no REST or swarmy.yaml form
 * yet, so this is what swarmy sees (read-only, links from `mesh.links`), the
 * client command each server's agent reads its link facts from, and the
 * NetBird client lines a laptop runs (NetBird's own CLI).
 */
export function PrivateNetworkCode({ n, links }: { n: PrivateNetwork; links?: MeshLinkLike[] }): React.JSX.Element {
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
      links: (links ?? []).map((l) => ({ between: [name(l.a), name(l.b)], [`${name(l.a)}→${name(l.b)}`]: l.ab, [`${name(l.b)}→${name(l.a)}`]: l.ba })),
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
  // What each server's agent runs every 20 s for latency, path and bytes per peer.
  const server =
    n.driver === 'headscale'
      ? ['# on a server: path and bytes per peer (no latency here)', 'docker exec swarmy-tailscale tailscale status --json'].join('\n')
      : ['# on a server: latency, connection type and bytes per peer', 'docker exec swarmy-netbird netbird status --json'].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'Live state', code: live },
        { label: 'Server', code: server },
        { label: 'Laptop', code: laptop },
      ]}
      source="readonly"
    />
  );
}
