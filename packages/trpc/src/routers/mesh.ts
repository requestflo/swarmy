import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  enrollNode,
  getConfig,
  grantDirectRoute,
  listDrivers,
  listPeers,
  listRoutes,
  previewAccess,
  revokeDirectRoute,
  setControlPlane,
  setDriver,
  setEnabled,
} from '../services/mesh.service';
import {
  cancelMigration,
  nodesOnMesh,
  resumeMigration,
  startMigration,
  swarmMeshStatus,
} from '../services/mesh-migration.service';
import { commandRejected } from '../errors';

const driverEnum = z.enum(['none', 'netbird', 'headscale', 'tailscale', 'wireguard']);

export const meshRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  listDrivers: orgProcedure.query(() => listDrivers()),

  setDriver: adminProcedure
    .input(z.object({ driver: driverEnum }))
    .mutation(({ ctx, input }) => setDriver(ctx, input.driver)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean(), force: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      // Turning the mesh off under nodes that advertise on it strands them —
      // move the swarm off first (`migrateSwarm` off-mesh + disableWhenDone).
      if (!input.enabled && !input.force) {
        const stranded = await nodesOnMesh(ctx);
        if (stranded.length > 0) {
          throw commandRejected(
            `${stranded.join(', ')} still ${stranded.length === 1 ? 'runs' : 'run'} the swarm over the mesh — move the swarm off the mesh first.`,
          );
        }
      }
      return setEnabled(ctx, input.enabled);
    }),

  /** Configure (or clear) the control plane (NetBird/Headscale URL + token, or a SaaS key). Secrets encrypted at rest. */
  setControlPlane: adminProcedure
    .input(
      z
        .object({
          mode: z.enum(['managed-by-swarmy', 'external']),
          managementUrl: z.string().url().optional(),
          serviceToken: z.string().optional(),
        })
        .nullable(),
    )
    .mutation(({ ctx, input }) => setControlPlane(ctx, input)),

  listPeers: orgProcedure.query(({ ctx }) => listPeers(ctx)),

  /** Provision + dispatch `applyMesh` to join a node to the mesh. */
  enrollNode: adminProcedure
    .input(
      z.object({
        nodeId: z.string(),
        advertiseRoutes: z.array(z.string()).optional(),
      }),
    )
    .mutation(({ ctx, input }) => enrollNode(ctx, input)),

  // ── Swarm over mesh: re-pin a RUNNING swarm's advertise/data-path addrs ──

  /** Per-node picture (address, on-mesh, planned action) + the persisted run. */
  swarmStatus: orgProcedure
    .input(z.object({ direction: z.enum(['onto-mesh', 'off-mesh']).optional() }).optional())
    .query(({ ctx, input }) => swarmMeshStatus(ctx, input?.direction)),

  /** Start the rolling, resumable one-node-at-a-time move (onto or off the mesh). */
  migrateSwarm: adminProcedure
    .input(
      z.object({
        direction: z.enum(['onto-mesh', 'off-mesh']).default('onto-mesh'),
        /** Required when the plan carries warnings (pinned data, controller host…). */
        acknowledgeWarnings: z.boolean().optional(),
        /** off-mesh: turn the mesh off once every node is back on its own address. */
        disableWhenDone: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => startMigration(ctx, input)),

  resumeMigration: adminProcedure.mutation(({ ctx }) => resumeMigration(ctx)),

  cancelMigration: adminProcedure.mutation(({ ctx }) => cancelMigration(ctx)),

  // ── Direct stack connect (Phase 2) ──────────────────────────────────────

  routes: router({
    list: orgProcedure.query(({ ctx }) => listRoutes(ctx)),

    /** Preview the ACL a grant would create — no writes. */
    preview: orgProcedure
      .input(z.object({ port: z.number().int().positive().optional(), proto: z.enum(['tcp', 'udp']).optional() }))
      .query(({ ctx, input }) => previewAccess(ctx, input)),

    /** Grant a point-to-point route to a service/stack; returns join info + setup key. */
    grant: adminProcedure
      .input(
        z.object({
          serviceId: z.string().optional(),
          stackId: z.string().optional(),
          principalType: z.enum(['peer', 'group', 'member']).optional(),
          principalId: z.string().min(1),
          port: z.number().int().positive().optional(),
          proto: z.enum(['tcp', 'udp']).optional(),
          ttlSec: z.number().int().positive().optional(),
        }),
      )
      .mutation(({ ctx, input }) => grantDirectRoute(ctx, input)),

    revoke: abacProcedure('token.revoke')
      .input(z.object({ routeId: z.string() }))
      .mutation(({ ctx, input }) => revokeDirectRoute(ctx, input.routeId)),
  }),
});
