import { REGION_OF_LABEL, REGION_PARENT_LABEL } from '@swarmy/core';
import type { RegionUpstream } from '@swarmy/ingress';

/**
 * Region-sibling upstream discovery (geo-edge). The region-reconcile worker
 * materialises `swarmy.region.<region>.replicas` labels into SIBLING services
 * named `${parent}-${region}` (labels swarmy.region.parent/of), pinned to that
 * region's nodes and attached to the parent's networks — so every Caddy can
 * dial every sibling over the shared overlay, cross-region hops riding the
 * mesh. Pure: takes the live service list, returns render input.
 */

export interface LiveServiceLite {
  name: string;
  labels?: Record<string, string>;
}

/**
 * The region upstream set for one routed service, or undefined when it has no
 * materialised siblings (→ plain VIP render, byte-identical legacy output).
 * Sorted by region for deterministic renders.
 */
export function regionUpstreamsFor(
  serviceName: string,
  port: number,
  liveServices: readonly LiveServiceLite[],
): RegionUpstream[] | undefined {
  const siblings: RegionUpstream[] = [];
  for (const s of liveServices) {
    if (s.labels?.[REGION_PARENT_LABEL] !== serviceName) continue;
    const region = s.labels[REGION_OF_LABEL];
    if (!region) continue;
    siblings.push({ service: s.name, port, region });
  }
  if (siblings.length === 0) return undefined;
  return siblings.sort((a, b) =>
    a.region === b.region
      ? a.service < b.service
        ? -1
        : 1
      : a.region < b.region
        ? -1
        : 1,
  );
}

/**
 * Stable signature of the org's sibling topology — the region-reconcile worker
 * compares this across ticks to trigger an ingress reapply exactly when the
 * sibling set changes (a new `web-za-johannesburg` starts receiving preferred
 * traffic within one tick).
 */
export function siblingSetSignature(liveServices: readonly LiveServiceLite[]): string {
  return liveServices
    .filter((s) => s.labels?.[REGION_PARENT_LABEL])
    .map((s) => `${s.labels?.[REGION_PARENT_LABEL]}→${s.name}@${s.labels?.[REGION_OF_LABEL] ?? ''}`)
    .sort()
    .join(';');
}
