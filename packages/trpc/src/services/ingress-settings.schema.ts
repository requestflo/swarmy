/**
 * The org's ingress settings as ONE patch — the input of
 * `updateIngressSettings` (ingress-settings.service.ts), which the per-field
 * `ingress.*` setters and `PUT /api/v1/ingress/settings` both ride. Pure:
 * the shape, the read-back view, and the checks a patch must pass before
 * anything is written.
 *
 * Patch semantics: a field left out keeps its current value; `null` clears a
 * nullable one. Secrets (tunnel run token, DNS provider token) are
 * write-only — the view says whether one is set, never what it is.
 */
import { z } from 'zod';
import { BYO_DNS_PROVIDERS, EdgeGeoipSettingSchema, type ByoDnsProvider, type EdgeGeoipMode } from '@swarmy/ingress';

export const INGRESS_DRIVERS = ['caddy', 'none', 'cloudflared'] as const;
export const INGRESS_TOPOLOGIES = ['controller', 'edge-per-node'] as const;

export const IngressTlsPatchSchema = z
  .object({
    /** ACME account email (Let's Encrypt expiry notices); `null` clears it. */
    acmeEmail: z.string().email().max(254).nullable().optional(),
    /** On-demand certificates for customer domains. */
    onDemand: z.boolean().optional(),
    /** The endpoint Caddy asks before issuing on demand; `null` clears it. */
    askUrl: z.string().url().max(2048).nullable().optional(),
  })
  .strict();

export const IngressTunnelPatchSchema = z
  .object({
    /** Cloudflare tunnel run token (encrypted at rest, never returned). Needed to connect. */
    runToken: z.string().min(20).max(4096).optional(),
    tunnelName: z.string().max(100).optional(),
    replicas: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export const IngressDnsProviderPatchSchema = z
  .object({ provider: z.enum(BYO_DNS_PROVIDERS), apiToken: z.string().min(20).max(512) })
  .strict();

export const IngressSettingsPatchSchema = z
  .object({
    driver: z.enum(INGRESS_DRIVERS).optional(),
    enabled: z.boolean().optional(),
    topology: z.enum(INGRESS_TOPOLOGIES).optional(),
    /** Caddy image both topologies run; `null` = swarmy's default build. */
    controllerImage: z.string().min(1).max(512).nullable().optional(),
    /** Node ids the replicated controller is pinned to; `[]` clears the pin. */
    targetNodes: z.array(z.string()).max(256).optional(),
    tls: IngressTlsPatchSchema.optional(),
    /** `null` disconnects the tunnel. */
    tunnel: IngressTunnelPatchSchema.nullable().optional(),
    /** BYO DNS-01 provider for wildcards in zones swarmy doesn't serve; `null` clears it. */
    dnsProvider: IngressDnsProviderPatchSchema.nullable().optional(),
    /** The country database the edge's country rules read (`file` needs a `path`). */
    geoip: EdgeGeoipSettingSchema.strict().optional(),
    /** Wildcard-IP base automatic addresses fall back to (e.g. nip.io); `null` = the controller default. */
    autoAddressBase: z.string().max(253).nullable().optional(),
  })
  .strict();

export type IngressSettingsPatch = z.infer<typeof IngressSettingsPatchSchema>;
export type IngressPatchField = keyof IngressSettingsPatch;

/** The full readable ingress settings (`getIngressSettings`). Never a secret value. */
export interface IngressSettingsView {
  orgId: string;
  driver: (typeof INGRESS_DRIVERS)[number];
  enabled: boolean;
  topology: (typeof INGRESS_TOPOLOGIES)[number];
  controllerImage: string | null;
  defaultControllerImage: string;
  targetNodes: string[];
  tls: { acmeEmail: string | null; onDemand: boolean; askUrl: string | null };
  tunnel: { tunnelId: string | null; tunnelName: string; replicas: number; runTokenSet: boolean } | null;
  dnsProvider: { provider: ByoDnsProvider; setAt: string; apiTokenSet: boolean } | null;
  /** The chosen country database (`bundled` when never set); `path` only for `file`. */
  geoip: { mode: EdgeGeoipMode; path: string | null };
  /** The org's own wildcard-IP base (null = not set). */
  autoAddressBase: string | null;
  updatedAt: string;
}

/** What the checks need to know about the settings as they are now. */
export interface CurrentIngressFacts {
  acmeEmail: string | null;
  onDemand: boolean;
  askUrl: string | null;
  tunnelConfigured: boolean;
}

/** Fields whose change alters the edge SERVICE (image, placement, mounts, whether it runs). */
export const DEPLOY_FIELDS: readonly IngressPatchField[] = ['driver', 'enabled', 'controllerImage', 'targetNodes', 'dnsProvider'];

/** Fields that never touch the edge render: a patch of only these skips the apply. */
export const RENDER_FREE_FIELDS: readonly IngressPatchField[] = ['autoAddressBase'];

/** The fields a patch sets, in a stable order. */
export function patchFields(patch: IngressSettingsPatch): IngressPatchField[] {
  return (Object.keys(IngressSettingsPatchSchema.shape) as IngressPatchField[]).filter((k) => patch[k] !== undefined);
}
