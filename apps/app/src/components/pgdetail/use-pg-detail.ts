import { useQuery } from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';
import type { PgCluster } from '@/components/stack-data/pg-ha-section';
import type { PgBackupFacts } from '@/components/stack-data/pg-choices';
import { useMemberServers } from '@/components/stack-data/use-member-servers';
import type { PgTopoMember } from './pg-topology';

/** `db.get`'s cluster with the fields this page reads beyond the Data tab's. */
export type PgDetailCluster = PgCluster & {
  members: PgTopoMember[];
  writeRegion?: string;
  regionReplicas?: Record<string, number>;
  primaries?: number;
  /** Declared memory limit per copy (MB); absent = no limit. */
  memoryMb?: number;
};

/**
 * Everything one database's page reads: the cluster (`db.get`), whether a
 * switch-over can honestly be automatic (`db.failoverReadiness`), its saves
 * (`dbBackups.overview`), the app's restore drill (`resilience.overview`), who
 * it's wired into (`stacks.endpoints`), pgvector (`vector.pgvector`), the main
 * copy's memory (`services.usage`) and which servers each member is on.
 */
export function usePgDetail(stack: string, cluster: string) {
  const trpc = useTRPC();
  const db = useQuery({ ...trpc.db.get.queryOptions({ stack }), refetchInterval: 4_000 });
  const c = ((db.data?.clusters ?? []) as PgDetailCluster[]).find((x) => x.name === cluster) ?? null;
  const readiness = useQuery({ ...trpc.db.failoverReadiness.queryOptions({ stack, cluster }), enabled: !!c });
  const overview = useQuery({ ...trpc.dbBackups.overview.queryOptions(), refetchInterval: 30_000 });
  const resilience = useQuery({ ...trpc.resilience.overview.queryOptions({ stack }), refetchInterval: 30_000 });
  const endpoints = useQuery({ ...trpc.stacks.endpoints.queryOptions({ stack }), refetchInterval: 15_000 });
  const pgvector = useQuery({ ...trpc.vector.pgvector.queryOptions({ stack }), refetchInterval: 10_000 });
  const usage = useQuery({
    ...trpc.services.usage.queryOptions({ id: c?.primary.service ?? '' }),
    enabled: !!c && c.primary.status === 'running',
    refetchInterval: 10_000,
    retry: false,
  });
  const place = useMemberServers(`${stack}_${cluster}-`, !!c);

  const backup: PgBackupFacts | null = (overview.data ?? []).find((r) => r.stack === stack && r.cluster === cluster) ?? null;
  const drill = resilience.data?.drills.find((d) => d.kind === 'restore') ?? null;
  const pg = (pgvector.data ?? []).find((v) => v.cluster === cluster) ?? null;
  const attached = (endpoints.data?.resources ?? []).find((r) => r.kind === 'postgres' && r.name === cluster)?.attached ?? null;

  return {
    pending: db.isPending,
    error: db.error,
    retry: () => void db.refetch(),
    cluster: c,
    readiness: readiness.data ?? null,
    backup,
    // The RTO is the last PASSED restore drill; name its cluster only when that is the latest drill.
    drill: drill?.rtoEstimateMs != null ? { rtoMs: drill.rtoEstimateMs, target: drill.last?.status === 'passed' ? drill.last.target : null } : null,
    pgvector: pg,
    attached,
    usage: usage.data ?? null,
    place: place.byService,
    nodes: place.nodes ?? [],
  };
}

export type PgDetailData = ReturnType<typeof usePgDetail>;
