import { useQuery } from '@tanstack/react-query';
import type { DbBackupSnapshotView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import type { ActionOutcomeView, AppPreview, GitApp } from '../gitops-types';

export interface PreviewData {
  /** The Postgres the preview's plan created (its copy), when it has one. */
  cluster: string | null;
  /** The environment stack the copy came from. */
  fromStack: string | null;
  /** The newest backup of that cluster now; null when there is none, undefined while reading. */
  snapshot: DbBackupSnapshotView | null | undefined;
  /** How the copy step went (restore + scrub), from the preview's plan. */
  outcome: ActionOutcomeView | undefined;
  ready: boolean;
}

/**
 * A preview's data story from real reads: its plan (`apps.plan` — which
 * Postgres it created and how that step went) and the source cluster's
 * backups (`dbBackups.list`).
 */
export function usePreviewData(app: GitApp, preview: AppPreview): PreviewData {
  const trpc = useTRPC();
  const plan = useQuery({ ...trpc.apps.plan.queryOptions({ planId: preview.planId }), staleTime: 15_000 });
  // A resource.create step carries the resource (`resource.type`); older rows a `resourceType`.
  const actions = (plan.data?.plan?.actions ?? []) as Array<{ id: string; kind: string; name?: string; resourceType?: string; resource?: { type?: string } }>;
  const db = actions.find((a) => a.kind === 'resource.create' && (a.resource?.type ?? a.resourceType) === 'postgres');
  const cluster = db?.name ?? null;
  const fromStack = preview.data ? (app.environments.find((e) => e.environment === preview.data?.from)?.stack ?? null) : null;
  const snaps = useQuery({
    ...trpc.dbBackups.list.queryOptions({ stack: fromStack ?? '', cluster: cluster ?? '' }),
    enabled: !!fromStack && !!cluster,
    staleTime: 60_000,
  });
  return {
    cluster,
    fromStack,
    snapshot: !fromStack || !cluster ? null : snaps.data ? (snaps.data[0] ?? null) : snaps.isError ? null : undefined,
    outcome: db ? plan.data?.outcomes[db.id] : undefined,
    ready: !plan.isPending,
  };
}
