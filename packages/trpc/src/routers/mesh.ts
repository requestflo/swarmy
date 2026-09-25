import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  enrollNode,
  getConfig,
  listPeers,
  setControlPlane,
  setDriver,
  setEnabled,
} from '../services/mesh.service';
import { nodesOnMesh } from '../services/mesh-onmesh';
import { commandRejected } from '../errors';
import { getControlPlaneCard, moveControlPlane, reconcileMeshControl, setBreakGlass } from '../services/mesh-control.service';
import {
  connectInfo,
  getPeopleAccessCard,
  grantPerson,
  listConnectedPeople,
  listPersonGrants,
  revokePersonGrant,
  revokePersonPeer,
  setPeopleAccess,
} from '../services/mesh-people.service';

const isAdmin = (role: string | undefined) => role === 'owner' || role === 'admin';

const driverEnum = z.enum(['none', 'netbird', 'headscale']);

export const meshRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),
  setDriver: adminProcedure
    .input(z.object({ driver: driverEnum }))
    .mutation(({ ctx, input }) => setDriver(ctx, input.driver)),

  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean(), force: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      // Turning the mesh off under servers that run the swarm over it strands
      // them — refuse; moving a server off the mesh means reinstalling it.
      if (!input.enabled && !input.force) {
        const stranded = await nodesOnMesh(ctx);
        if (stranded.length > 0) {
          throw commandRejected(
            `${stranded.join(', ')} still ${stranded.length === 1 ? 'runs' : 'run'} the swarm over the mesh — reinstall ${stranded.length === 1 ? 'it' : 'them'} without --mesh first.`,
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

  // ── Self-hosted control plane (NetBird inside swarmy) ────────────────────

  control: router({
    /** The Mesh settings control-plane card (live status is the hosting node's telemetry). */
    status: orgProcedure.query(({ ctx }) => getControlPlaneCard(ctx)),
    /** Converge now (bootstrap policies, connector, backups, config). */
    reconcile: adminProcedure.mutation(({ ctx }) => reconcileMeshControl(ctx, { force: true })),
    /** Re-show NetBird's local owner login (break-glass); off again when done. */
    breakGlass: adminProcedure.input(z.object({ on: z.boolean() })).mutation(({ ctx, input }) => setBreakGlass(ctx, input.on)),
    /** Move to another manager: fence, restore from Litestream, start there. */
    move: adminProcedure.input(z.object({ nodeId: z.string() })).mutation(({ ctx, input }) => moveControlPlane(ctx, input.nodeId)),
  }),

  // ── People on the mesh ─────────────────────────────────────────────────

  people: router({
    card: orgProcedure.query(({ ctx }) => getPeopleAccessCard(ctx)),
    /** On/off (off by default) + the login expiry for people's devices. */
    setSettings: adminProcedure
      .input(z.object({ enabled: z.boolean().optional(), loginExpiryHours: z.number().int().min(1).max(24 * 30).optional() }))
      .mutation(({ ctx, input }) => setPeopleAccess(ctx, input)),
    /** "Connect from your laptop" on an app: commands, what you reach, and why. */
    connectInfo: orgProcedure.input(z.object({ stack: z.string().min(1) })).query(({ ctx, input }) => connectInfo(ctx, input.stack)),
    /** Who's connected right now. Admins see everyone; others see their own devices. */
    connected: orgProcedure.input(z.object({ stack: z.string().optional() }).optional()).query(async ({ ctx, input }) => {
      const all = await listConnectedPeople(ctx, { stack: input?.stack });
      if (isAdmin(ctx.membership?.role)) return all;
      const email = ctx.user?.email?.toLowerCase();
      return all.filter((p) => email && p.email.toLowerCase() === email);
    }),
    grants: orgProcedure.input(z.object({ stack: z.string().optional() }).optional()).query(({ ctx, input }) => listPersonGrants(ctx, input?.stack)),
    /** A personal, optionally TTL'd grant on one stack (MeshRoute kind=person). */
    grant: adminProcedure
      .input(
        z.object({
          stack: z.string().min(1),
          userId: z.string().min(1),
          service: z.string().optional(),
          port: z.number().int().min(1).max(65535).optional(),
          ttlSec: z.number().int().positive().max(90 * 86400).optional(),
        }),
      )
      .mutation(({ ctx, input }) => grantPerson(ctx, input)),
    revoke: adminProcedure.input(z.object({ grantId: z.string() })).mutation(({ ctx, input }) => revokePersonGrant(ctx, input.grantId)),
    /** Disconnect one device now (it must sign in again). */
    revokeDevice: adminProcedure.input(z.object({ peerId: z.string() })).mutation(({ ctx, input }) => revokePersonPeer(ctx, input.peerId)),
  }),
});
