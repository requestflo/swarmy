import { z } from 'zod';

// Wire/render types are owned by @swarmy/core so the agent and the controller
// share one definition. The ingress package re-exports them.
export {
  RenderedConfig,
  RenderedFile,
  ServiceLabels,
  IngressStatus,
  IngressDriverName,
} from '@swarmy/core/protocol';
export type {
  RenderedConfig as RenderedConfigT,
  RenderedFile as RenderedFileT,
  ServiceLabels as ServiceLabelsT,
  IngressStatus as IngressStatusT,
} from '@swarmy/core/protocol';

import type { RenderedConfig, IngressStatus } from '@swarmy/core/protocol';

// ── Org-scoped config (persisted, controller-side) ─────────────────────

/**
 * Scale-to-zero COLD routing for a domain. When a `DomainRoute` carries `cold`,
 * the service backing it is asleep (scale-to-zero, 0 running replicas) and ingress
 * must route the domain to the controller **activator** — which wakes the service,
 * waits for it to come live, then 307s the caller back — instead of proxying to the
 * (down) service. Absent ⇒ warm: a normal upstream to `service:port`.
 *
 * Pure render input: the controller computes this from live Docker state
 * (`ctx.hub.liveInventory`) and the activator's reachable address; the renderer
 * only turns it into the driver's reverse-proxy/rewrite syntax.
 */
export const ColdRouteSchema = z.object({
  /**
   * Activator dial target as `host:port`. On a single-node Docker Desktop swarm
   * this is `host.docker.internal:3001` (the host, reachable from containers).
   */
  upstream: z.string().min(1),
  /** Wake endpoint path for THIS service, e.g. `/_wake/<service>`. */
  wakePath: z.string().min(1),
});
export type ColdRoute = z.infer<typeof ColdRouteSchema>;

/**
 * Weighted canary upstream (slice D2). Present on a route while a canary
 * rollout is in flight: renderers emit BOTH upstreams (stable first, canary
 * second) with a weighted load-balancing policy so `weightPct` percent of the
 * route's traffic reaches the canary. Pure render input — the controller reads
 * it off the `swarmy.ingress.routes` service label (Docker truth).
 */
export const CanaryUpstreamSchema = z.object({
  /** Canary Docker service name (e.g. `web--canary`). */
  service: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** Share of traffic (0–100) routed to the canary upstream. */
  weightPct: z.number().min(0).max(100),
});
export type CanaryUpstream = z.infer<typeof CanaryUpstreamSchema>;

export const DomainRouteSchema = z.object({
  domain: z.string().min(1),
  pathPrefix: z.string().default('/'),
  service: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['auto', 'off', 'custom']).default('auto'),
  stripPathPrefix: z.boolean().default(false),
  middlewares: z.array(z.string()).default([]),
  /**
   * Scale-to-zero COLD override. Present ⇒ route to the activator (wake-on-request)
   * instead of `service:port`; absent ⇒ warm (direct upstream). See {@link ColdRouteSchema}.
   */
  cold: ColdRouteSchema.optional(),
  /** Weighted canary upstream (D2). Absent ⇒ 100% stable. */
  canary: CanaryUpstreamSchema.optional(),
});
export type DomainRoute = z.infer<typeof DomainRouteSchema>;

/**
 * Caddy HA shared-storage (caddy-storage-redis). When present, the Caddy renderer
 * emits a global `storage redis { … }` block so every Caddy instance shares one
 * ACME account + cert pool. `null`/absent ⇒ single-node behaviour (unchanged).
 */
export const HaStorageSchema = z.object({
  /** Redis host the managed/BYO Redis listens on. */
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(6379),
  /** Logical DB index. */
  db: z.number().int().nonnegative().default(0),
  /** Key namespace so multiple orgs can share one Redis. */
  keyPrefix: z.string().default('caddy'),
  tlsEnabled: z.boolean().default(false),
  /**
   * Plaintext secrets are NEVER stored here — the controller resolves these from
   * the credential vault at render/dispatch time and injects them just-in-time.
   */
  username: z.string().optional(),
  password: z.string().optional(),
  /** At-rest encryption key for cert material in Redis (resolved from vault). */
  encryptionKey: z.string().optional(),
});
export type HaStorage = z.infer<typeof HaStorageSchema>;

/**
 * Cloudflare Tunnel connector options. Secrets (API token / run token / tunnel
 * credentials JSON) are resolved from the credential vault just-in-time; the
 * controller injects them here only for the render that is dispatched.
 */
export const TunnelOptionsSchema = z.object({
  provider: z.enum(['cloudflare']).default('cloudflare'),
  /** Cloudflare account id (for the API). */
  accountId: z.string().optional(),
  /** Cloudflare-assigned tunnel UUID. */
  tunnelId: z.string().optional(),
  tunnelName: z.string().default('swarmy'),
  /** Connector image (pin cloudflared ≥ 2025.4.0 for token mode). */
  image: z.string().default('cloudflare/cloudflared:latest'),
  replicas: z.number().int().min(1).default(1),
  /** Resolved-just-in-time run token (token mode). */
  runToken: z.string().optional(),
  /** Resolved-just-in-time credentials JSON (locally-managed mode). */
  credentialsJson: z.string().optional(),
  metricsAddr: z.string().optional(),
});
export type TunnelOptions = z.infer<typeof TunnelOptionsSchema>;

export const IngressGlobalOptionsSchema = z.object({
  email: z.string().email().optional(),
  onDemandTls: z.boolean().default(false),
  defaultTls: z.enum(['auto', 'off']).default('auto'),
  network: z.string().default('swarmy'),
  /** Caddy HA shared-cert storage. Absent ⇒ single-node Caddy. */
  haStorage: HaStorageSchema.optional(),
  /** Cloudflare Tunnel connector config (for the cloudflared driver). */
  tunnel: TunnelOptionsSchema.optional(),
  /** Raw escape hatch (driver-typed): applyVia, provider, certs, onDemandAsk, etc. */
  extraConfig: z.record(z.unknown()).default({}),
});
export type IngressGlobalOptions = z.infer<typeof IngressGlobalOptionsSchema>;

export const IngressConfigSchema = z.object({
  driver: z.string().min(1),
  enabled: z.boolean().default(true),
  orgId: z.string(),
  targetNodes: z.array(z.string()).default([]),
  domains: z.array(DomainRouteSchema).default([]),
  globalOptions: IngressGlobalOptionsSchema.default({}),
});
export type IngressConfig = z.infer<typeof IngressConfigSchema>;

export type IngressValidationResult =
  | { ok: true }
  | { ok: false; errors: { path: string; message: string }[] };

export interface IngressStatusReportLite {
  nodeId: string;
  ok: boolean;
  message?: string;
}

/**
 * How a driver pushes work to node agent(s) and queries them. Implemented by
 * the controller (apps/api) over the agent WebSocket gateway. Driver code is
 * transport-agnostic — it only calls these.
 */
export interface DriverDispatch {
  sendToNode(nodeId: string, rendered: RenderedConfig): Promise<IngressStatusReportLite>;
  resolveTargetNodes(orgId: string, explicit: string[]): Promise<string[]>;
  queryStatus(nodeId: string, driver: string): Promise<IngressStatus>;
}

export interface IngressDriver {
  readonly name: string;
  validate(config: IngressConfig): IngressValidationResult;
  /** Pure, no IO. */
  render(config: IngressConfig): RenderedConfig;
  apply(
    rendered: RenderedConfig,
    dispatch: DriverDispatch,
    config: IngressConfig,
  ): Promise<IngressStatus>;
  status(config: IngressConfig, dispatch: DriverDispatch): Promise<IngressStatus>;
}
