import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
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

const driverEnum = z.enum(['none', 'netbird', 'headscale', 'tailscale', 'wireguard']);

export const meshRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  listDrivers: orgProcedure.query(() => listDrivers()),

  setDriver: adminProcedure
    .input(z.object({ driver: driverEnum }))
    .mutation(({ ctx, input }) => setDriver(ctx, input.driver)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

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

    revoke: adminProcedure
      .input(z.object({ routeId: z.string() }))
      .mutation(({ ctx, input }) => revokeDirectRoute(ctx, input.routeId)),
  }),
});
