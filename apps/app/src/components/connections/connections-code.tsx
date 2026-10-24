import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import type { StackEndpoints } from './types';

/** `GET /stacks/{id}/endpoints` as REST sends it (api-rest stackEndpointsToDto: snake_case). */
function endpointsDto(e: StackEndpoints) {
  return {
    stack: e.stack,
    connected_apps: e.connectedApps,
    services: e.services.map((s) => ({
      service: s.service,
      short_name: s.short,
      ports: s.ports,
      names: s.names.map((n) => ({ host: n.host, port: n.port ?? null, scope: n.scope, reachable_from: n.from ?? [] })),
    })),
    resources: e.resources.map((r) => ({ kind: r.kind, name: r.name, host: r.host, port: r.port, role: r.role ?? null, attached: r.attached })),
  };
}

/** `connect: [a, b]`, the flow style swarmy.yaml examples use. */
function connectLine(peers: string[]): string {
  return `connect: [${[...new Set(peers)].sort().join(', ')}]`;
}

/**
 * The Connections tab as code: the app's `connect:` list in swarmy.yaml, the
 * same reads and changes over REST (`/stacks/{id}/endpoints`,
 * `/stacks/{id}/connections`), and the Docker labels that are the record of
 * each pairing.
 */
export function ConnectionsCode({ endpoints: e, peer }: { endpoints: StackEndpoints; peer: string | undefined }): React.JSX.Element {
  const linked = e.connectedApps;
  const yaml = [
    `# ${e.stack}/swarmy.yaml (excerpt)`,
    'version: 1',
    `app: ${e.stack}`,
    linked.length ? connectLine(linked) : '# no connect: list, so no other app can reach it',
    ...(peer && !linked.includes(peer) ? ['', `# to connect ${peer} as well`, connectLine([...linked, peer])] : []),
  ].join('\n');
  const other = peer ?? '<app>';
  const rest = [
    '# the names on this page ({id} takes the app\'s id or name)',
    restExchange('GET', `/stacks/${e.stack}/endpoints`, endpointsDto(e)),
    '',
    '# connect or disconnect one pair: deploy permission on both apps (an',
    '# app-scoped key must reach both), audited as stack.link.add / stack.link.remove',
    curl('POST', `/stacks/${e.stack}/connections`, { peer: other }),
    '',
    curl('DELETE', `/stacks/${e.stack}/connections/${other}`),
  ].join('\n');
  const width = Math.max(0, ...e.services.map((s) => s.service.length)) + 2;
  const labels = [
    '# Docker is the record: each app service carries the apps it is linked to',
    ...e.services.map((s) => {
      const from = s.names.find((n) => n.scope === 'connected')?.from ?? [];
      return `${s.service.padEnd(width)}${from.length ? `swarmy.links=${from.join(',')}` : '(no swarmy.links: isolated)'}`;
    }),
    '',
    '# and joins one overlay per pair, swarmy-link-<hash of org, app, peer>,',
    `# answering there as <service>.${e.stack}. Managed data never joins.`,
  ].join('\n');
  return (
    <CodeView
      tabs={[
        { label: 'swarmy.yaml', code: yaml },
        { label: 'REST', code: rest },
        { label: 'labels', code: labels },
      ]}
      note="Lives in each app’s swarmy.yaml (connect). Apps deployed from git list each other there, or the next deploy disconnects them. Connecting here applies now."
    />
  );
}
