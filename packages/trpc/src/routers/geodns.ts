import { z } from 'zod';
import { adminProcedure, orgProcedure, router } from '../trpc';
import {
  applyNow,
  checkDomain,
  getConfig,
  listDnsView,
  listRegions,
  setConfig,
  setEnabled,
  setNodeRegion,
} from '../services/geodns.service';
import {
  checkDelegation,
  createZone,
  listZones,
  previewResolution,
  removeZone,
  setAdvertisedNs,
  updateZone,
} from '../services/dns-zones.service';
import { listRecords, removeRecord, upsertRecord } from '../services/dns-records.service';

/**
 * Geo-DNS ("swarmy is the nameserver"). Zones are the registrar-facing
 * artifact; web records derive from ingress; manual records cover MX/TXT/….
 */
export const geodnsRouter = router({
  // ── org config ──
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  /** Org geoip settings (source, MaxMind secret ref, air-gapped mmdb config). */
  setConfig: adminProcedure
    .input(
      z.object({
        geoipSource: z.enum(['dbip', 'maxmind', 'file', 'off']).optional(),
        maxmindLicenseSecretRef: z.string().optional(),
        mmdbConfigRef: z.string().optional(),
      }),
    )
    .mutation(({ ctx, input }) => setConfig(ctx, input)),

  /** Master switch — deploys/removes the swarmy-dns global service. */
  setEnabled: adminProcedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEnabled(ctx, input.enabled)),

  /** Force compose + push + provider sync now. */
  applyNow: adminProcedure.mutation(({ ctx }) => applyNow(ctx)),

  // ── zones ──
  listZones: orgProcedure.query(({ ctx }) => listZones(ctx)),

  createZone: adminProcedure
    .input(
      z.object({
        zone: z.string().min(4),
        mode: z.enum(['swarmy-ns', 'cloudflare', 'route53']).optional(),
      }),
    )
    .mutation(({ ctx, input }) => createZone(ctx, input)),

  updateZone: adminProcedure
    .input(
      z.object({
        id: z.string(),
        enabled: z.boolean().optional(),
        mode: z.enum(['swarmy-ns', 'cloudflare', 'route53']).optional(),
        ttl: z.number().int().min(10).max(120).optional(),
        apexToEdge: z.boolean().optional(),
        autoWww: z.boolean().optional(),
        provider: z
          .object({
            zoneId: z.string().optional(),
            tokenEnv: z.string().optional(),
            region: z.string().optional(),
          })
          .optional(),
      }),
    )
    .mutation(({ ctx, input: { id, ...patch } }) => updateZone(ctx, id, patch)),

  removeZone: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeZone(ctx, input.id)),

  /** Pin 2–4 nodes as the advertised nameserver set (→ ns1..nsN + glue). */
  setAdvertisedNs: adminProcedure
    .input(z.object({ id: z.string(), nodeIds: z.array(z.string()).min(2).max(4) }))
    .mutation(({ ctx, input }) => setAdvertisedNs(ctx, input.id, input.nodeIds)),

  /** Live delegation check: public NS lookup + direct SOA query per glue IP. */
  checkDelegation: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) => checkDelegation(ctx, input.id)),

  /** "Resolve from <region>" — the exact answer a client there would get. */
  previewResolution: orgProcedure
    .input(z.object({ id: z.string(), host: z.string().min(1), region: z.string().optional() }))
    .query(({ ctx, input }) => previewResolution(ctx, input.id, input)),

  // ── manual records (MX/TXT/CNAME/SRV/CAA/NS) ──
  listRecords: orgProcedure
    .input(z.object({ zoneId: z.string() }))
    .query(({ ctx, input }) => listRecords(ctx, input.zoneId)),

  upsertRecord: adminProcedure
    .input(
      z.object({
        zoneId: z.string(),
        name: z.string().min(1).max(253),
        type: z.enum(['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'SRV', 'CAA', 'NS']),
        value: z.string().min(1).max(4096),
        ttl: z.number().int().min(10).max(86400).optional(),
        priority: z.number().int().min(0).max(65535).optional(),
      }),
    )
    .mutation(({ ctx, input }) => upsertRecord(ctx, input)),

  removeRecord: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => removeRecord(ctx, input.id)),

  // ── views / diagnostics ──
  /** Region markers for the Infrastructure globe. */
  listRegions: orgProcedure.query(({ ctx }) => listRegions(ctx)),

  /** Derived-DNS table: every hostname swarmy answers, with endpoint health. */
  dnsView: orgProcedure
    .input(z.object({ stack: z.string().optional() }).optional())
    .query(({ ctx, input }) => listDnsView(ctx, input?.stack)),

  /** Probe one host: intended answers vs public DNS + reachability. */
  checkDomain: orgProcedure
    .input(z.object({ host: z.string().min(1) }))
    .query(({ ctx, input }) => checkDomain(ctx, input.host)),

  /** Assign a node's region (writes `swarmy.region` label via updateSwarmNode). */
  setNodeRegion: adminProcedure
    .input(z.object({ nodeId: z.string(), region: z.string().min(1) }))
    .mutation(({ ctx, input }) => setNodeRegion(ctx, input.nodeId, input.region)),
});
