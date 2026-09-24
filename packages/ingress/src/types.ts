import { z } from 'zod';
import { HostRedirectSchema } from './www';
import { DnsChallengeSchema } from './dns-challenge';
import { RouteAuthSchema } from './app-auth';

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
   * Activator dial target as `host:port` — the controller on the swarmy overlay
   * (`swarmy_controller:3021`), or `host.docker.internal:3021` for a dev controller on the host.
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
  /**
   * "Protect my app" (identity-aware proxy). Present ⇒ every request is
   * forward-authed against the swarmy controller before it reaches the
   * upstream (or wakes a cold one); client-sent `X-Swarmy-*` headers are
   * dropped first. Controller-computed from the route label's `access.login`.
   * See `app-auth.ts`. Absent ⇒ byte-identical legacy output.
   */
  auth: RouteAuthSchema.optional(),
});
export type DomainRoute = z.infer<typeof DomainRouteSchema>;

/**
 * Caddy shared certificate storage in S3-compatible object storage
 * (techknowlogick/certmagic-s3, compiled into docker/caddy-swarmy). When present,
 * the Caddy renderer emits a global `storage s3 { … }` block so every edge
 * shares ONE ACME account + cert pool + challenge store — what makes
 * edge-per-node issuance work under geo-DNS. swarmy points it at its own
 * replicated Garage store (bucket `swarmy-edge-certs`).
 *
 * Carries NO credentials, by construction: the module resolves them through the
 * AWS SDK default chain, which swarmy satisfies with a Docker secret mounted as
 * `AWS_SHARED_CREDENTIALS_FILE` on the Caddy service. Nothing secret can reach
 * the rendered Caddyfile, the admin API or the autosaved config.
 * Absent ⇒ Caddy's default local file storage (the single-controller path).
 */
export const CertStorageSchema = z.object({
  kind: z.literal('s3'),
  /** S3 endpoint as seen from the Caddy task (overlay DNS), e.g. `http://swarmy-garage:3900`. */
  endpoint: z.string().url(),
  bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'bucket names are lowercase DNS labels'),
  /** SigV4 region — must equal the store's configured region (Garage rejects a mismatch). */
  region: z.string().regex(/^[A-Za-z0-9_-]+$/),
  /** Object key prefix (per-org, so one bucket could serve several orgs). */
  prefix: z.string().regex(/^[A-Za-z0-9_./-]+$/).default('caddy'),
  /**
   * Absolute path (inside the Caddy task) of a Docker-secret file holding the
   * `encryption_key …` line, imported into the block: objects are sealed
   * client-side before they reach the store. The key itself never appears in
   * the rendered Caddyfile. Absent ⇒ plaintext objects (legacy stores).
   */
  encryptionKeyFile: z.string().regex(/^\/[A-Za-z0-9_./-]+$/).optional(),
});
export type CertStorage = z.infer<typeof CertStorageSchema>;

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
  /** Shared certificate storage (S3 / swarmy object storage). Absent ⇒ Caddy's local file storage. */
  certStorage: CertStorageSchema.optional(),
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
  /**
   * What this vhost fronts. `dashboard` is the controller's own UI/API (the
   * self-host installer's https login domain): `targetPath` is `/` and the
   * renderer proxies it verbatim (no rewrite — /api, /agent/ws, /install all
   * pass through). The other kinds drive labeling/diagnostics only.
   */
  kind: z.enum(['status-page', 'webhook', 'ai-gateway', 'dashboard']),
  tls: z.enum(['auto', 'off']).default('auto'),
});
export type ControllerVhost = z.infer<typeof ControllerVhostSchema>;

const bucketName = z.string().regex(/^[a-z0-9][a-z0-9.-]{1,62}$/, 'invalid bucket name');

/**
 * swarmy object storage (Garage S3) exposed through the edge, per bucket.
 * Caddy is the gate: only paths of listed buckets reach Garage, everything
 * else is a 403 at the edge — an INTERNAL bucket is never routable. Garage
 * still requires SigV4 (keys or a presigned signature): reachable ≠ anonymous.
 */
export const ObjectStorageEdgeSchema = z.object({
  /** Garage S3 dial target on the swarmy overlay, e.g. `swarmy-garage:3900`. */
  upstream: z.string().min(1),
  /** HTTPS hostname for PUBLIC buckets (path-style: https://<domain>/<bucket>/<key>). */
  publicDomain: z.string().min(1).optional(),
  publicBuckets: z.array(bucketName).default([]),
  /** MESH buckets — plus every PUBLIC one — served on `meshPort` to mesh peers only. */
  meshBuckets: z.array(bucketName).default([]),
  /** Plain-HTTP listener for mesh peers (WireGuard already encrypts the hop). */
  meshPort: z.number().int().min(1).max(65535).default(3900),
  /** Source range a mesh request must come from (NetBird/Tailscale CGNAT). */
  meshCidr: z.string().default('100.64.0.0/10'),
});
export type ObjectStorageEdge = z.infer<typeof ObjectStorageEdgeSchema>;

export const IngressConfigSchema = z.object({
  driver: z.string().min(1),
  enabled: z.boolean().default(true),
  orgId: z.string(),
  targetNodes: z.array(z.string()).default([]),
  domains: z.array(DomainRouteSchema).default([]),
  /** Controller-upstream vhosts (status pages / webhooks / AI gateway domains). */
  controllerVhosts: z.array(ControllerVhostSchema).default([]),
  /**
   * Host-level redirects (apex ↔ www toggles, expanded by the controller via
   * `expandWww`). Each renders as a tiny site that 308s to `to` with the path
   * and query kept. A host that also has a route/vhost is skipped (explicit wins).
   */
  hostRedirects: z.array(HostRedirectSchema).optional(),
  /**
   * ACME DNS-01 for wildcard hosts (controller-planned, `planDnsChallenges`):
   * which hosts solve DNS-01 and through which provider. Coordinates only —
   * tokens are read by the edge from Docker secret files, never rendered.
   */
  dnsChallenge: DnsChallengeSchema.optional(),
  /** Per-bucket S3 exposure (absent = object storage stays in-cluster only). */
  objectStorage: ObjectStorageEdgeSchema.optional(),
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
