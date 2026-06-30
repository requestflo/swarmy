import {
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from '@tanstack/react-query';
import { useTRPC } from '@/integrations/trpc';

/**
 * Runtime-resolved tRPC access for the managed-DB topology + DB-backup
 * procedures (`db.setTopology`, `dbBackup.*`).
 *
 * These procedures are added to the tRPC `AppRouter` by the data-plane backend
 * in the same epic and wired through this PR's integrationSnippets (root.ts, the
 * managed-DB / dbBackup routers, and the demo resolvers). `apps/app` must
 * typecheck against the *current* `AppRouter`, so the panels reach them through
 * the live tRPC proxy — which lazily builds any path and is intercepted by the
 * demo link or the HTTP link at runtime — and re-apply precise result types
 * here. This module is the SINGLE place where the path is resolved untyped;
 * every caller gets fully-typed inputs + data. At integration these helpers can
 * be swapped for the generated `trpc.dbBackup.*` accessors with no call-site
 * change beyond the hook name.
 */

interface ProcMethods {
  queryOptions: (input?: unknown) => Record<string, unknown>;
  mutationOptions: (opts?: unknown) => Record<string, unknown>;
}
type TrpcProxy = Record<string, Record<string, ProcMethods> | undefined>;

function resolveProc(trpc: unknown, router: string, name: string): ProcMethods | undefined {
  return (trpc as TrpcProxy)[router]?.[name];
}

export interface DbQueryOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/** Typed read of a procedure resolved at runtime (see module doc). */
export function useDbQuery<TOut>(
  router: string,
  name: string,
  input: unknown,
  opts: DbQueryOptions = {},
): UseQueryResult<TOut> {
  const trpc = useTRPC();
  const proc = resolveProc(trpc, router, name);
  const base = proc
    ? proc.queryOptions(input)
    : { queryKey: [router, name, input], queryFn: async (): Promise<unknown> => null };
  return useQuery({
    ...base,
    ...opts,
  } as unknown as UseQueryOptions<TOut, Error, TOut>) as UseQueryResult<TOut>;
}

export interface DbMutationOptions<TOut> {
  onSuccess?: (data: TOut) => void;
  onError?: (error: Error) => void;
}

/** Typed mutation of a procedure resolved at runtime (see module doc). */
export function useDbMutation<TOut, TIn>(
  router: string,
  name: string,
  opts: DbMutationOptions<TOut> = {},
): UseMutationResult<TOut, Error, TIn> {
  const trpc = useTRPC();
  const proc = resolveProc(trpc, router, name);
  const base = proc
    ? proc.mutationOptions(opts)
    : {
        ...opts,
        mutationFn: async (): Promise<unknown> => {
          throw new Error(`${router}.${name} is not available`);
        },
      };
  return useMutation(
    base as unknown as UseMutationOptions<TOut, Error, TIn>,
  ) as UseMutationResult<TOut, Error, TIn>;
}

// ── Shared endpoint contracts (mirrored by the backend routers + demo resolvers) ──

/** Managed-DB HA shapes the cluster can take; converged via `swarmy.db.topology`. */
export type DbTopologyMode =
  | 'single'
  | 'primary-replica'
  | 'failover'
  | 'geo'
  | 'active-active';

/** Per-region replica plan for the `geo` topology. */
export interface DbGeoRegion {
  region: string;
  replicas: number;
}

/** Current topology config for a cluster (surfaced on `db.get` clusters once wired). */
export interface DbTopologyConfig {
  topology: DbTopologyMode;
  /** Region that owns the single writer (geo / failover). */
  writeRegion?: string;
  regions?: DbGeoRegion[];
}

export interface SetTopologyResult {
  cluster: string;
  topology: DbTopologyMode;
}

/** Logical-backup engine for a managed cluster. */
export type DbBackupEngine = 'pg_dump' | 'pgbackrest' | 'replica-snapshot';

/** Restore strategy chosen from the canvas. */
export type DbRestoreMode = 'clone' | 'pitr' | 'in-place' | 'single-db';

export interface DbBackupView {
  id: string;
  cluster: string;
  engine: DbBackupEngine;
  status: string;
  sizeBytes: string | null;
  /** Postgres LSN captured at backup time (pgBackRest / PITR baselines). */
  lsn: string | null;
  targetId: string | null;
  targetName: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

export interface DbBackupScheduleView {
  enabled: boolean;
  engine: DbBackupEngine;
  every: number;
  unit: 'hours' | 'days';
  targetId: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
}

/** One row of the global Database-backups card on the Backups page. */
export interface DbBackupOverviewRow {
  stack: string;
  cluster: string;
  engine: DbBackupEngine;
  lastBackupAt: string | null;
  lastStatus: string | null;
  sizeBytes: string | null;
  targetName: string | null;
  count: number;
}
