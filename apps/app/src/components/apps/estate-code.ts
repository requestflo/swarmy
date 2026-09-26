import type { NodeSummary } from '@swarmy/core';
import { restExchange, withHeader } from '@/components/calm';
import type { AppItem } from './use-apps';

interface StackRow {
  id: string;
  name: string;
  serviceCount: number;
  status: string;
  updatedAt: string;
}

/** `GET /api/v1/stacks` — the same list `stacks.list` feeds the dashboard. */
export function stacksRest(stacks: StackRow[]): string {
  return restExchange('GET', '/stacks', {
    data: stacks.map((s) => ({
      id: s.id,
      name: s.name,
      service_count: s.serviceCount,
      status: s.status,
      updated_at: s.updatedAt,
    })),
    next_cursor: null,
  });
}

/** `GET /api/v1/nodes` (the REST API still says node for a server). */
export function nodesRest(nodes: NodeSummary[]): string {
  return restExchange('GET', '/nodes', {
    data: nodes.map((n) => ({
      id: n.id,
      name: n.name,
      hostname: n.hostname,
      role: n.role,
      status: n.status,
      engine_version: n.engineVersion,
      os: n.os,
      arch: n.arch,
      last_seen_at: n.lastSeenAt,
    })),
    next_cursor: null,
  });
}

/** One app's services the way `swarmy status` prints them (● = all copies up). */
export function statusLines(app: AppItem): string[] {
  const out = app.stat.services.map((s) => {
    const ok = s.replicas.running >= s.replicas.desired;
    return `  ${ok ? '●' : '○'} ${s.name.padEnd(28)} ${`${s.replicas.running}/${s.replicas.desired}`.padEnd(6)} ${s.status}`;
  });
  return out.length ? out : ['  (no services running)'];
}

/** `swarmy status`, run inside each app's linked repo, from the same live data. */
export function statusCli(apps: AppItem[]): string {
  const blocks = apps.map((a) => [`# ${a.name}`, '$ swarmy status', ...statusLines(a)].join('\n'));
  return withHeader('swarmy status, run in each app’s linked repo', blocks.join('\n\n'));
}

interface GitAppRow {
  repoId: string;
  appName: string | null;
  branch: string;
  environments: { environment: string; branch: string; stack: string }[];
  previews: { pr: number; stack: string; status: string; url: string | null }[];
}

/** `GET /api/v1/apps` — git apps with their environments and previews (the Environments column). */
export function appsRest(apps: GitAppRow[]): string {
  return restExchange('GET', '/apps', {
    data: apps.map((a) => ({
      repo_id: a.repoId,
      app_name: a.appName,
      branch: a.branch,
      environments: a.environments.map((e) => ({ environment: e.environment, branch: e.branch, stack: e.stack })),
      previews: a.previews.map((p) => ({ pr: p.pr, stack: p.stack, status: p.status, url: p.url })),
    })),
    next_cursor: null,
  });
}
