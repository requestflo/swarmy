import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  applyNow,
  checkDomain,
  getConfig,
  listDnsView,
  listRecords,
  previewZone,
  removeRecord,
  setConfig,
  setEnabled,
  setNodeRegion,
  upsertRecord,
} from '../services/geodns.service';

export const geodnsRouter = router({
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  setConfig: adminProcedure
    .input(
      z.object({
        zone: z.string().min(1).optional(),
        ttl: z.number().int().min(10).max(120).optional(),
      }),
    )
    .mutation(({ ctx, input }) => setConfig(ctx, input)),

  /** Master switch — enabling deploys CoreDNS via the existing deploy path. */
  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

  listRecords: orgProcedure.query(({ ctx }) => listRecords(ctx)),

  /** Live DNS view: each zone endpoint with its resolved IP + health (table). */
  dnsView: orgProcedure.query(({ ctx }) => listDnsView(ctx)),

  /** Probe one host: expected vs actual resolved IP + reachability (diagnostic). */
  checkDomain: orgProcedure
    .input(z.object({ host: z.string().min(1) }))
    .query(({ ctx, input }) => checkDomain(ctx, input.host)),

  upsertRecord: adminProcedure
    .input(
      z.object({
        host: z.string().min(1),
        region: z.string().min(1),
        targetIngress: z.string().min(1),
        healthy: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => upsertRecord(ctx, input)),

  removeRecord: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeRecord(ctx, input.id)),

  previewZone: orgProcedure.query(({ ctx }) => previewZone(ctx)),

  /** Force a health-filtered re-render + redeploy of the CoreDNS zone now. */
  applyNow: adminProcedure.mutation(({ ctx }) => applyNow(ctx)),

  /** Assign a node's region (writes `swarmy.region` label via updateSwarmNode). */
  setNodeRegion: adminProcedure
    .input(z.object({ nodeId: z.string(), region: z.string().min(1) }))
    .mutation(({ ctx, input }) => setNodeRegion(ctx, input.nodeId, input.region)),
});
