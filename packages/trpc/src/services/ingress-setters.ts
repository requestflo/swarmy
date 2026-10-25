/**
 * The per-field `ingress.*` setters, kept for the dashboard and every
 * existing caller. Each is a thin wrapper over the one settings write
 * (`applyIngressSettings`): same validation, same persistence, one converge,
 * one audit row (the setter's own action name). They answer what they always
 * answered — the config view, or the field's own view (DNS-01, country
 * database, automatic-address base).
 */
import type { OrgContext } from '../context';
import type { ByoDnsProvider, EdgeGeoipSetting } from '@swarmy/ingress';
import { getDnsChallengeView, type DnsChallengeView } from './acme-dns.service';
import { getAutoAddressBase, type AutoAddressBaseView } from './auto-address-base.service';
import { getEdgeGeoip, type EdgeGeoipView } from './edge-geoip.service';
import { getConfig, type IngressConfigView, type IngressDriverId } from './ingress.service';
import { applyIngressSettings } from './ingress-settings.service';
import type { IngressSettingsPatch } from './ingress-settings.schema';

async function setVia(ctx: OrgContext, patch: IngressSettingsPatch): Promise<IngressConfigView> {
  await applyIngressSettings(ctx, patch);
  return getConfig(ctx);
}

/** Picking Caddy while enabled deploys it — never silently nothing on 80/443. */
export const setDriver = (ctx: OrgContext, driver: IngressDriverId) => setVia(ctx, { driver });

export const setEnabled = (ctx: OrgContext, enabled: boolean) => setVia(ctx, { enabled });

/**
 * Switch the edge topology (ingress-topology.ts has the swap and its
 * ordering). The current topology is a no-op: nothing is removed, recreated,
 * saved or audited.
 */
export const setTopology = (ctx: OrgContext, topology: 'controller' | 'edge-per-node') => setVia(ctx, { topology });

/** Set (or clear) the Caddy image; the running edge rolls onto it. */
export const setControllerImage = (ctx: OrgContext, image: string | null) => setVia(ctx, { controllerImage: image });

/**
 * Pin the replicated controller to nodes (`[]` clears the pin and falls back
 * to the `swarmy.node.ingress` label / manager heuristic). Re-placed at once.
 */
export const setTargetNodes = (ctx: OrgContext, nodeIds: string[]) => setVia(ctx, { targetNodes: nodeIds });

/** Toggle on-demand TLS; an `askUrl` is recorded, an absent one keeps the current. */
export const setOnDemandTls = (ctx: OrgContext, input: { enabled: boolean; askUrl?: string }) =>
  setVia(ctx, { tls: { onDemand: input.enabled, ...(input.askUrl ? { askUrl: input.askUrl } : {}) } });

/**
 * Connect a Cloudflare tunnel by its run token (encrypted at rest; the tunnel
 * id is read from it), or disconnect with `null`. Public hostnames are added
 * on the Cloudflare side (the ingress preview lists the rules to add).
 */
export const setTunnel = (
  ctx: OrgContext,
  input: { runToken: string; tunnelName?: string; replicas?: number } | null,
) => setVia(ctx, { tunnel: input });

/**
 * Set (or clear, `null`) the BYO DNS provider token for wildcards in zones
 * swarmy DNS doesn't serve. The token goes only into a Docker secret.
 */
export async function setByoDnsProvider(
  ctx: OrgContext,
  input: { provider: ByoDnsProvider; apiToken: string } | null,
): Promise<DnsChallengeView> {
  await applyIngressSettings(ctx, { dnsProvider: input });
  return getDnsChallengeView(ctx);
}

/** Choose the edge's country database (`bundled`, `file` + a path, or `off`); the edge re-renders. */
export async function setEdgeGeoip(ctx: OrgContext, input: EdgeGeoipSetting): Promise<EdgeGeoipView> {
  await applyIngressSettings(ctx, { geoip: input });
  return getEdgeGeoip(ctx);
}

/**
 * Set (or clear, `null` / blank) the org's wildcard-IP base. Nothing
 * re-renders: the domain-verify worker re-hosts automatic addresses on its
 * next tick.
 */
export async function setAutoAddressBase(ctx: OrgContext, base: string | null): Promise<AutoAddressBaseView> {
  await applyIngressSettings(ctx, { autoAddressBase: base });
  return getAutoAddressBase(ctx);
}
