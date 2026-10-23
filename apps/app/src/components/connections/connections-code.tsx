import * as React from 'react';
import { CodeView } from '@/components/calm';
import type { StackEndpoints } from './types';

/** `connect: [a, b]`, the flow style swarmy.yaml examples use. */
function connectLine(peers: string[]): string {
  return `connect: [${[...new Set(peers)].sort().join(', ')}]`;
}

/**
 * The Connections tab as code: the app's `connect:` list in swarmy.yaml, the
 * dashboard calls behind the page (tRPC; no public REST route yet), and the
 * Docker labels that are the record of each pairing.
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
  const calls = [
    '# the names on this page (a dashboard query: tRPC, not public REST)',
    `stacks.endpoints { "stack": "${e.stack}" }`,
    JSON.stringify(e, null, 2),
    '',
    '# connect or disconnect one pair: deploy permission on both apps,',
    '# audited as stack.link.add / stack.link.remove',
    `stacks.connect { "stack": "${e.stack}", "peer": "${other}" }`,
    `stacks.disconnect { "stack": "${e.stack}", "peer": "${other}" }`,
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
        { label: 'tRPC', code: calls },
        { label: 'labels', code: labels },
      ]}
      note="Lives in each app’s swarmy.yaml (connect). Apps deployed from git list each other there, or the next deploy disconnects them. Connecting here applies now."
    />
  );
}
