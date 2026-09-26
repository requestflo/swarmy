import type { BlueprintMetaView, BlueprintPlanView } from '@swarmy/core';

/** One box in a "what gets created" graph. */
export interface GraphNode {
  key: string;
  label: string;
  /** Mono detail (image tag, port, engine). */
  detail?: string;
  kind: 'entry' | 'app' | 'data' | 'backup';
}

export interface GraphModel {
  /** Visitors / HTTPS. Null for private apps (only other apps reach them). */
  entry: GraphNode | null;
  app: GraphNode;
  /** Other services, managed data, and the nightly backup. */
  data: GraphNode[];
}

const MANAGED_NAME: Record<string, string> = { postgres: 'postgres', cache: 'cache', bucket: 'files', search: 'search' };
const MANAGED_DETAIL: Record<string, string> = {
  postgres: 'managed Postgres',
  cache: 'managed cache',
  bucket: 'S3 bucket',
  search: 'managed search',
};

/** The service visitors reach: the catalogue's own say, else the one named like the app. */
export function primaryOf(meta: BlueprintMetaView, planned?: string[]): string {
  const services = meta.services?.length ? meta.services : (planned ?? []);
  return meta.primaryService ?? services.find((s) => s === meta.id) ?? services[0] ?? meta.id;
}

/**
 * The graph for a template, from its catalogue metadata and (when loaded) its
 * dry-run plan: HTTPS → the app → its other services and managed data, plus
 * the nightly backup managed Postgres is born with.
 */
export function graphModel(
  meta: BlueprintMetaView,
  opts: { plan?: BlueprintPlanView; host?: string | null; backup?: string | null } = {},
): GraphModel {
  const deployStep = opts.plan?.steps.find((s) => s.kind === 'stack.deploy');
  const planned = deployStep?.detail.services?.split(', ').filter(Boolean);
  const primary = primaryOf(meta, planned);
  const services = planned?.length ? planned : (meta.services ?? []);
  const isPrivate = meta.resources.includes('Private');
  const entry: GraphNode | null = isPrivate
    ? null
    : { key: 'entry', label: 'HTTPS', detail: opts.host ?? undefined, kind: 'entry' };
  const app: GraphNode = {
    key: 'app',
    label: primary,
    detail: [meta.version && `v${meta.version}`, meta.httpPort && `:${meta.httpPort}`].filter(Boolean).join(' · ') || undefined,
    kind: 'app',
  };
  const data: GraphNode[] = services
    .filter((s) => s !== primary)
    .map((s) => ({ key: `svc-${s}`, label: s, detail: 'internal', kind: 'data' as const }));
  const managed = opts.plan
    ? [
        ...(opts.plan.steps.some((s) => s.kind === 'db.provision') ? ['postgres'] : []),
        ...(opts.plan.steps.some((s) => s.kind === 'cache.provision') ? ['cache'] : []),
        ...(opts.plan.steps.some((s) => s.kind === 'bucket') ? ['bucket'] : []),
        ...((meta.managed ?? []).includes('search') ? ['search'] : []),
      ]
    : (meta.managed ?? []);
  for (const m of managed) {
    data.push({ key: `m-${m}`, label: MANAGED_NAME[m] ?? m, detail: MANAGED_DETAIL[m], kind: 'data' });
  }
  if (managed.includes('postgres')) {
    data.push({ key: 'backup', label: 'nightly backup', detail: opts.backup ?? 'pg_dump · kept 7 days', kind: 'backup' });
  }
  return { entry, app, data };
}
