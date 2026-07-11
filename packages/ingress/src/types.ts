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
   * this is `host.docker.internal:3021` (the host, reachable from containers).
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

/**
 * Per-route edge protections (stack-level "rate limits & protections"). Pure
 * render input: renderers translate these into driver syntax (Caddy:
 * `rate_limit` via mholt/caddy-ratelimit, `@matchers` + `abort`/`respond`,
 * `request_body max_size`). Drivers without support ignore what they can't
 * express — validation warns, render never throws.
 */
export const RateLimitRuleSchema = z.object({
  /** Max requests per window. */
  requests: z.number().int().min(1),
  /** Window length in seconds. */
  windowSeconds: z.number().int().min(1),
  /** What a client is keyed by: remote IP (default) or a header value. */
  key: z.enum(['ip', 'header']).default('ip'),
  /** Header name when `key` is 'header' (e.g. X-Api-Key). */
  header: z.string().optional(),
});
export type RateLimitRule = z.infer<typeof RateLimitRuleSchema>;

/**
 * Per-route response cache (Caddy: `cache` directive from
 * caddyserver/cache-handler — needs the swarmy Caddy build, see
 * docker/caddy-swarmy). Cold (scale-to-zero) routes never cache: the response
 * is the activator's wake redirect, not the service's.
 */
export const CacheRuleSchema = z.object({
  /** Response TTL in seconds (1s .. 24h). */
  ttlSeconds: z.number().int().min(1).max(86400),
  /** Extra request headers folded into the cache key (e.g. Accept-Language). */
  keyHeaders: z.array(z.string().min(1)).optional(),
  /** How long a stale entry may be served while revalidating upstream. */
  staleWhileRevalidateSeconds: z.number().int().min(1).max(86400).optional(),
});
export type CacheRule = z.infer<typeof CacheRuleSchema>;

/** ISO 3166-1 alpha-2, uppercase — the only shape mmdb country lookups return. */
export const CountryCodeSchema = z
  .string()
  .regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 country code (uppercase), e.g. "GB"');

/**
 * WAF-lite: plain Caddy matchers + 403, no plugin. Deliberately a thin tier —
 * a real rule engine (OWASP CRS via Coraza) is the escalation path, not this.
 */
export const WafRuleSchema = z.object({
  /** Block the curated scanner-path list (WAF_SCANNER_PATHS). Default on. */
  blockScannerPaths: z.boolean().default(true),
  /** HTTP methods to reject outright (e.g. TRACE, DELETE). */
  blockMethods: z
    .array(z.string().regex(/^[A-Z]+$/, 'HTTP method, uppercase (e.g. TRACE)'))
    .default([]),
  /**
   * Regex patterns 403'd when they match the raw query string. Must compile
   * (checked with JS RegExp after normalising Go/RE2 inline-flag groups like
   * `(?i)`, which Caddy accepts but JS rejects) and must not carry
   * backticks/double-quotes, which cannot be escaped safely into the rendered
   * CEL expression matcher.
   */
  denyQueryPatterns: z
    .array(
      z
        .string()
        .min(1)
        .refine((s) => !s.includes('`') && !s.includes('"'), {
          message: 'pattern must not contain backticks or double quotes',
        })
        .refine(isCompilableRe2Pattern, {
          message: 'pattern must be a valid regular expression',
        }),
    )
    .default([]),
});
export type WafRule = z.infer<typeof WafRuleSchema>;

/**
 * Best-effort compile check for a Go/RE2 pattern using the JS engine: RE2
 * inline flag syntax (`(?i)…`, `(?i:…)`) is valid for Caddy but throws in JS,
 * so those groups are normalised away before compiling. A pattern passing here
 * can still be rejected by RE2 in edge cases — this catches the typo class
 * (unbalanced brackets/parens), not full RE2 equivalence.
 */
function isCompilableRe2Pattern(s: string): boolean {
  const jsCompat = s.replace(/\(\?[ims]+(-[ims]+)?:/g, '(?:').replace(/\(\?[ims]+(-[ims]+)?\)/g, '');
  try {
    new RegExp(jsCompat);
    return true;
  } catch {
    return false;
  }
}

export const RouteProtectionSchema = z.object({
  /** Sliding-window rate limit for this route. */
  rateLimit: RateLimitRuleSchema.optional(),
  /** CIDRs/IPs allowed — non-matching requests are aborted. Empty = allow all. */
  ipAllow: z.array(z.string()).default([]),
  /** CIDRs/IPs denied — matching requests are aborted. */
  ipDeny: z.array(z.string()).default([]),
  /** Max request body size, e.g. "10MB". */
  bodyMaxSize: z.string().optional(),
  /** Abort requests whose User-Agent matches known bot/scanner patterns. */
  blockBots: z.boolean().default(false),
  /** Headers that must be present (optionally with an exact value). */
  requiredHeaders: z
    .array(z.object({ name: z.string().min(1), value: z.string().optional() }))
    .default([]),
  /** Response caching (cache-handler plugin — swarmy Caddy build only). */
  cache: CacheRuleSchema.optional(),
  /**
   * Countries allowed — requests from anywhere else are aborted. Absent/empty =
   * allow all. Rendered with the maxmind_geolocation matcher, which needs BOTH
   * the swarmy Caddy build AND `extraConfig.geoipMmdbPath`; without the mmdb
   * path the rule renders as NOTHING (validate() warns — never a silent
   * lockout). Optional (not defaulted) so pre-existing compacted label shapes
   * round-trip unchanged.
   */
  countryAllow: z.array(CountryCodeSchema).optional(),
  /** Countries denied — matching requests are aborted. Deny wins over allow. */
  countryDeny: z.array(CountryCodeSchema).optional(),
  /** WAF-lite (scanner paths / methods / query patterns) — plain matchers. */
  waf: WafRuleSchema.optional(),
});
export type RouteProtection = z.infer<typeof RouteProtectionSchema>;

/**
 * One region-local candidate upstream for a route (geo-edge). `service` is a
 * region SIBLING service name materialised by the region-reconcile worker
 * (`${parent}-${region}`, labels swarmy.region.parent/of) — dialable from any
 * node over the shared overlay, cross-region hops riding the mesh. Present
 * only when siblings exist; renderers order these local-region-first.
 */
export const RegionUpstreamSchema = z.object({
  service: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  /** The `swarmy.region.of` label value this sibling is pinned to. */
  region: z.string().min(1),
});
export type RegionUpstream = z.infer<typeof RegionUpstreamSchema>;

export const DomainRouteSchema = z.object({
  domain: z.string().min(1),
  pathPrefix: z.string().default('/'),
  service: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  tls: z.enum(['auto', 'off', 'custom']).default('auto'),
  stripPathPrefix: z.boolean().default(false),
  middlewares: z.array(z.string()).default([]),
  /** Edge protections (rate limit, IP rules, body cap, bot/header rules). */
  protection: RouteProtectionSchema.optional(),
  /**
   * Scale-to-zero COLD override. Present ⇒ route to the activator (wake-on-request)
   * instead of `service:port`; absent ⇒ warm (direct upstream). See {@link ColdRouteSchema}.
   */
  cold: ColdRouteSchema.optional(),
  /** Weighted canary upstream (D2). Absent ⇒ 100% stable. */
  canary: CanaryUpstreamSchema.optional(),
  /**
   * Region-sibling upstream set (geo-edge). Present ⇒ warm renders emit an
   * ordered multi-upstream proxy (receiving node's region first, automatic
   * cross-region failover). Absent ⇒ plain `service:port` (byte-identical
   * legacy output). Precedence: cold > canary > regionUpstreams > plain.
   */
  regionUpstreams: z.array(RegionUpstreamSchema).optional(),
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
  /**
   * Emit an OpenTelemetry span per proxied request (Caddy `tracing` directive).
   * Controller-computed: set when swarmy observability is enabled, so the edge
   * exports spans to the collector (OTLP env on the controller container). Every
   * hit to a fronted service then shows up as an edge span in Observability.
   */
  tracing: z.boolean().default(false),
  /**
   * Raw escape hatch (driver-typed): applyVia, provider, certs, onDemandAsk,
   * geoipMmdbPath (country-mmdb path inside the ingress container — enables
   * countryAllow/countryDeny rendering), etc.
   */
  extraConfig: z.record(z.unknown()).default({}),
});
export type IngressGlobalOptions = z.infer<typeof IngressGlobalOptionsSchema>;

/**
 * A vhost that proxies straight to the swarmy controller instead of a swarm
 * service — the one shared primitive behind custom domains for status pages,
 * inbound webhook endpoints, and the AI gateway. The controller computes the
 * list at render time from persisted rows (StatusPage.domain,
 * InboundEndpoint.domain, AI outlet config); renderers emit a reverse-proxy
 * vhost with a path rewrite onto the controller upstream.
 */
export const ControllerVhostSchema = z.object({
  domain: z.string().min(1),
  /** Controller dial target as host:port, reachable from the ingress container. */
  upstream: z.string().min(1),
  /** Controller path the vhost's `/` maps onto, e.g. `/s/my-page` or `/hooks/gh`. */
  targetPath: z.string().min(1),
  /** What this vhost fronts — drives labeling/diagnostics only. */
  kind: z.enum(['status-page', 'webhook', 'ai-gateway']),
  tls: z.enum(['auto', 'off']).default('auto'),
});
export type ControllerVhost = z.infer<typeof ControllerVhostSchema>;

export const IngressConfigSchema = z.object({
  driver: z.string().min(1),
  enabled: z.boolean().default(true),
  orgId: z.string(),
  targetNodes: z.array(z.string()).default([]),
  domains: z.array(DomainRouteSchema).default([]),
  /** Controller-upstream vhosts (status pages / webhooks / AI gateway domains). */
  controllerVhosts: z.array(ControllerVhostSchema).default([]),
  /**
   * Region of the node THIS render targets (geo-edge). Pure data — the driver
   * renders once per target node, threading that node's `swarmy.region` label
   * here so region upstream ordering prefers local tasks. Absent ⇒ stable
   * region-name ordering (correct, just unpreferenced).
   */
  localRegion: z.string().optional(),
  globalOptions: IngressGlobalOptionsSchema.default({}),
});
export type IngressConfig = z.infer<typeof IngressConfigSchema>;

/** A non-blocking validation note (config renders/applies, but degraded). */
export interface IngressValidationWarning {
  path: string;
  message: string;
}

export type IngressValidationResult =
  | { ok: true; warnings?: IngressValidationWarning[] }
  | { ok: false; errors: { path: string; message: string }[]; warnings?: IngressValidationWarning[] };

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
  /**
   * Target nodes WITH their region labels (geo-edge). Optional so non-regional
   * drivers keep working; the Caddy driver prefers this when present to render
   * per-node region-ordered upstreams.
   */
  resolveTargets?(
    orgId: string,
    explicit: string[],
  ): Promise<Array<{ nodeId: string; region?: string }>>;
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
