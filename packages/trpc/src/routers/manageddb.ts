import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure, resolveStackByName, resolveStackService } from '../abac';
import {
  DB_TOPOLOGIES,
  confirmFailover,
  getDbTopology,
  injectConnection,
  migrateStorage,
  provisionDb,
  removeDb,
  revealDbPassword,
  rotateDbPassword,
  setRegionReplicas,
  setReplicas,
  setTopology,
  getFailoverReadiness,
  setWriteRegion,
} from '../services/manageddb.service';

/** `postgres://user:secret@host` → `postgres://user:***@host`. */
export function maskUrlPassword(url: string): string {
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^:/@]*:)[^@]*@/i, '$1***@');
}

const stackName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name');

const clusterName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid cluster name');

/** A node-label region value (`swarmy.region`) — same charset as a label value segment. */
const regionName = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid region');

const topologyEnum = z.enum(DB_TOPOLOGIES);

/**
 * Managed DB topology (epic #8). Declare a Postgres primary/replica cluster for
 * a stack, read its live health, scale replicas, and inject the connection env
 * into an app service — all Docker-truth (labels), no new Prisma model.
 */
export const managedDbRouter = router({
  /** Provision a cluster (deploy primary + N replicas, stamp swarmy.db.* labels). */
  provision: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        name: clusterName,
        engine: z.literal('postgres').default('postgres'),
        /** Omitted ⇒ 1 standby on another server when the swarm has 2+ ready servers; 0 opts out. */
        replicas: z.number().int().min(0).max(20).optional(),
        password: z.string().min(8).max(128).optional(),
        database: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[A-Za-z0-9_]+$/, 'invalid database name')
          .optional(),
        imageTag: z.string().min(1).max(40).optional(),
        /** Full engine image override (official postgres image contract, e.g. postgres:17); wins over imageTag. */
        image: z
          .string()
          .min(1)
          .max(255)
          .regex(/^[a-z0-9][a-z0-9._/:@-]*$/i, 'invalid image reference')
          .optional(),
      }),
    )
    // Never carries the password — see `revealPassword`.
    .mutation(({ ctx, input }) => provisionDb(ctx, input)),

  /**
   * Reveal a cluster's superuser password: the one explicit, ABAC-gated
   * (`secrets.read`, audited permit/deny) path a client reads it through;
   * the service adds a `db.password.reveal` audit row.
   */
  revealPassword: abacProcedure('secrets.read', resolveStackByName)
    .input(z.object({ stack: stackName, cluster: clusterName }))
    .mutation(({ ctx, input }) => revealDbPassword(ctx, input)),

  /**
   * Rotate a cluster's password: a new `<family>__v<n+1>` secret, the writers
   * (a brief restart) then standbys then every wired app move onto it, old
   * versions removed. Owner/admin-only (`secret.delete`: it retires the old
   * secret versions); audited `db.password.rotate`. Returns no password.
   */
  rotatePassword: abacProcedure('secret.delete', resolveStackByName)
    .input(z.object({ stack: stackName, cluster: clusterName }))
    .mutation(({ ctx, input }) => rotateDbPassword(ctx, input)),

  /** Read the managed-DB topology for a stack (clusters + health + rw/ro hosts). */
  get: orgProcedure
    .input(z.object({ stack: stackName }))
    .query(({ ctx, input }) => getDbTopology(ctx, input.stack)),

  /** Scale a cluster's read replicas to N. */
  setReplicas: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        replicas: z.number().int().min(0).max(20),
      }),
    )
    .mutation(({ ctx, input }) => setReplicas(ctx, input)),

  /**
   * Select (or change, in-situ) the cluster's HA topology. The reconcile worker
   * converges live infra to match — single | primary-replica | failover | geo |
   * active-active.
   */
  /** Can `failover` honestly work for this cluster now? `reason` when not (shown in the topology picker). */
  failoverReadiness: orgProcedure
    .input(z.object({ stack: z.string().min(1), cluster: z.string().min(1) }))
    .query(({ ctx, input }) => getFailoverReadiness(ctx, input)),

  setTopology: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        topology: topologyEnum,
        // geo: applied in one call so the UI fully provisions the geo shape.
        writeRegion: z.string().min(1).max(63).optional(),
        regions: z
          .array(z.object({ region: z.string().min(1).max(63), replicas: z.number().int().min(0).max(50) }))
          .optional(),
      }),
    )
    .mutation(({ ctx, input }) => setTopology(ctx, input)),

  /**
   * Confirm a HELD failover (no replica provably caught up). The caller names
   * the replica and the data-loss window they accept; the reconcile promotes
   * only while the window stays within it. Destructive (may lose the last
   * writes) → the `data.failover` policy gate, owner/admin by default.
   */
  confirmFailover: abacProcedure('data.failover')
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        target: z.string().min(1).max(200),
        acceptBehindBytes: z.union([z.number().int().min(0), z.literal('unknown')]),
      }),
    )
    .mutation(({ ctx, input }) => confirmFailover(ctx, input)),

  /** Geo: pin the single writer to a node-label region (`swarmy.region==<region>`). */
  setWriteRegion: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        region: regionName,
      }),
    )
    .mutation(({ ctx, input }) => setWriteRegion(ctx, input)),

  /** Geo: declare N read replicas pinned to a region (0 removes the region sibling). */
  setRegionReplicas: abacProcedure('stack.deploy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        region: regionName,
        replicas: z.number().int().min(0).max(20),
      }),
    )
    .mutation(({ ctx, input }) => setRegionReplicas(ctx, input)),

  /**
   * Move a legacy cluster whose primary keeps its data on an ANONYMOUS volume
   * (any restart would start it empty) onto the persistent layout: pg_dump of
   * the app database first, then an ONLINE pg_basebackup from the running
   * primary into `<stack>_<cluster>-primary-data` on its node (writes frozen
   * unless `allowWritesDuringCopy`), and only after the copy is verified a
   * redeploy mounted + pinned. The primary is never stopped before that.
   * Idempotent (`already` when done).
   */
  migrateStorage: adminProcedure
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        skipBackup: z.boolean().optional(),
        allowWritesDuringCopy: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => migrateStorage(ctx, input)),

  /**
   * Remove a managed Postgres (every member + its WAL shipper). Destructive →
   * the `data.destroy` policy gate (owner/admin by default) plus the typed
   * `confirm` phrase `<stack>/<cluster>`. Refused while an app is connected.
   * Data volumes are kept unless `deleteData`. Audited (`db.remove`).
   */
  remove: abacProcedure('data.destroy', resolveStackByName)
    .input(
      z.object({
        stack: stackName,
        cluster: clusterName,
        confirm: z.string().min(1).max(200),
        deleteData: z.boolean().default(false),
      }),
    )
    .mutation(({ ctx, input }) => removeDb(ctx, input)),

  /** Inject DATABASE_URL (+ *_RO_URL) env onto an app service in the stack. */
  inject: abacProcedure('service.configure', resolveStackService)
    .input(
      z.object({
        stack: stackName,
        appService: z.string().min(1),
        cluster: clusterName,
        envVar: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'invalid env var name')
          .optional(),
      }),
    )
    // The connection URLs embed the password — the response masks it (the app
    // gets the real URL in its env; a person reads it via `revealPassword`).
    .mutation(async ({ ctx, input }) => {
      const res = await injectConnection(ctx, input);
      return { ...res, rwUrl: maskUrlPassword(res.rwUrl), roUrl: maskUrlPassword(res.roUrl) };
    }),
});
