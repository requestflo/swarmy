import * as React from 'react';
import { CodeView, curl, restExchange } from '@/components/calm';
import { useMove } from './move/move-context';
import type { FleetServer } from './use-fleet';

/** The map, bulk actions and the move as dashboard calls (tRPC): the move has no REST route or CLI command yet. */
export function serversQueries(o: { id: string; service: string | null; to: string | null }): string {
  const j = (v: unknown): string => JSON.stringify(v);
  return [
    '# the map: regions, the private network, NAT labels, live numbers, what runs where',
    'geodns.listRegions',
    'mesh.listPeers',
    `nodes.get ${j({ id: o.id })}`,
    `nodes.liveStatsLatest ${j({ nodeId: o.id })}`,
    `services.list ${j({ nodeId: o.id })}`,
    '',
    '# selecting several: one call per server',
    `nodes.drain ${j({ id: o.id })}`,
    `nodes.setLabels ${j({ id: o.id, labels: { team: 'platform' } })}`,
    `nodes.upgradeAgent ${j({ id: o.id })}`,
    '',
    '# restart the agent (apps keep running); resolves when it checks back in',
    `nodes.restartAgent ${j({ id: o.id })}`,
    '',
    '# move a service and its data (admins; runs in the background)',
    `decommission.moveService ${j({ service: o.service ?? '<service>', toNodeId: o.to ?? '<server id>' })}`,
    '# progress: the service’s swarmy.move.state label in inventory.get',
  ].join('\n');
}

/**
 * The Servers page as code: the list swarmy is showing (GET /nodes), the
 * REST calls behind the inspector's buttons (every path is in
 * openapi.json), and the dashboard queries behind the map and the move.
 */
export function ServersCode({ servers, selected }: { servers: FleetServer[]; selected: FleetServer | null }): React.JSX.Element {
  const m = useMove();
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
  const moving = m.draft ? { service: m.draft.chip.name, to: m.target } : m.run ? { service: m.run.chip.name, to: m.run.toId } : { service: null, to: null };
  return (
    <CodeView
      tabs={[
        { label: 'REST', code: list },
        { label: 'actions', code: actions },
        { label: 'dashboard query', code: serversQueries({ id, ...moving }) },
      ]}
      source="readonly"
      note="What swarmy sees right now. The REST calls work with an API key, the SDKs and Terraform; the dashboard queries are tRPC."
    />
  );
}
