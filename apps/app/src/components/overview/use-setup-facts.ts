import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

export interface SetupFacts {
  /** Every fact below has settled; until then nothing is ticked or listed. */
  ready: boolean;
  backupTargets: { name: string }[];
  domainCount: number;
  meshOn: boolean;
  meshPeers: number;
  members: number;
}

/** The estate facts behind "Already on" and "Worth doing next", one query each. */
export function useSetupFacts(): SetupFacts {
  const trpc = useTRPC();
  const targets = useQuery(trpc.backups.listTargets.queryOptions());
  const ingress = useQuery(trpc.ingress.getConfig.queryOptions());
  const mesh = useQuery(trpc.mesh.getConfig.queryOptions());
  const members = useQuery(trpc.members.list.queryOptions());
  const all = [targets, ingress, mesh, members];
  return {
    // A failed read counts as settled-unknown: the item is simply not shown.
    ready: all.every((q) => !q.isPending),
    backupTargets: (targets.data ?? []).filter((t) => t.enabled),
    domainCount: ingress.data?.domainCount ?? 0,
    meshOn: mesh.data?.enabled ?? false,
    meshPeers: mesh.data?.peerCount ?? 0,
    members: members.data?.length ?? 0,
  };
}
