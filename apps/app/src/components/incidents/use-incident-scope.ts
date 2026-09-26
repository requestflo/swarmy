import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { SYSTEM_STACK, UNGROUPED, type IncidentDetailView, type Inventory, type ReleaseView } from '@swarmy/core';
import { useTRPC } from '@/integrations/trpc';
import { versionOf, type WordsContext } from './incident-words';
import { incidentScope, type IncidentScope } from './incident-scope';

/** The words context (service → app, app names, release versions) from the live inventory + releases. */
export function wordsContext(inventory: Inventory | undefined, releases: ReleaseView[] = []): WordsContext {
  const serviceApp = new Map<string, string>();
  const apps = new Set<string>();
  for (const s of inventory?.services ?? []) {
    if (s.stack === UNGROUPED) continue;
    serviceApp.set(s.name, s.stack);
    if (s.stack !== SYSTEM_STACK) apps.add(s.stack);
  }
  const versions = new Map<string, string>();
  for (const r of releases) {
    const v = versionOf(r.images);
    if (v) versions.set(r.id, v);
  }
  return { serviceApp, apps: [...apps], versions };
}

/** The live inventory and every release, as a words context (Stream rows, the room). */
export function useWordsContext(): { ctx: WordsContext; inventory: Inventory | undefined } {
  const trpc = useTRPC();
  const inventory = useQuery({ ...trpc.inventory.get.queryOptions(), refetchInterval: 30_000 });
  const releases = useQuery({ ...trpc.releases.list.queryOptions({ limit: 50 }), refetchInterval: 30_000 });
  const ctx = React.useMemo(() => wordsContext(inventory.data, releases.data), [inventory.data, releases.data]);
  return { ctx, inventory: inventory.data };
}

/** What the incident is about, and the app's releases (newest first). */
export function useIncidentScope(incident: IncidentDetailView): {
  scope: IncidentScope;
  ctx: WordsContext;
  inventory: Inventory | undefined;
  releases: ReleaseView[] | undefined;
} {
  const trpc = useTRPC();
  const { ctx, inventory } = useWordsContext();
  const scope = React.useMemo(() => incidentScope(incident, ctx), [incident, ctx]);
  const releases = useQuery({
    ...trpc.releases.list.queryOptions({ stackName: scope.app ?? '', limit: 20 }),
    enabled: scope.app !== null,
    refetchInterval: 15_000,
  });
  return { scope, ctx, inventory, releases: scope.app ? releases.data : [] };
}
