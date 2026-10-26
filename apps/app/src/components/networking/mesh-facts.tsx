import * as React from 'react';
import { Depth } from '@/components/calm';
import { DRIVER_LABELS, type MeshDriverId } from './mesh-format';
import type { MeshPeerLike } from './mesh-graph-model';
import { bestLatency, fmtMs, linkPath, type MeshLinkLike } from './mesh-link-words';

/**
 * Direct vs relayed: per link when any link between connected servers
 * reported its path (`mesh.links`), else per server over the connected ones
 * that reported it; null when none has.
 */
export function linkSplit(
  peers: MeshPeerLike[],
  links: readonly MeshLinkLike[] = [],
): { direct: number; relayed: number; per: 'link' | 'server' } | null {
  const on = new Set(peers.filter((p) => p.status === 'CONNECTED').map((p) => p.nodeId));
  const paths = links.filter((l) => on.has(l.a) && on.has(l.b)).flatMap((l) => linkPath(l) ?? []);
  if (paths.length) {
    const relayed = paths.filter((p) => p === 'relayed').length;
    return { direct: paths.length - relayed, relayed, per: 'link' };
  }
  const known = peers.filter((p) => p.status === 'CONNECTED' && p.relayed !== null);
  if (known.length === 0) return null;
  const relayed = known.filter((p) => p.relayed).length;
  return { direct: known.length - relayed, relayed, per: 'server' };
}

/** "0.4–19 ms" over the links' best round trips; null when no link reported one. */
export function latencySpan(links: readonly MeshLinkLike[] = []): string | null {
  const ms = links.flatMap((l) => bestLatency(l) ?? []);
  if (!ms.length) return null;
  const [lo, hi] = [fmtMs(Math.min(...ms)), fmtMs(Math.max(...ms))];
  return lo === hi ? lo : `${lo.replace(/ ms$/, '')}–${hi}`;
}

interface MeshConfigLike {
  driver: string;
  managementUrl: string | null;
  controlPlaneMode: 'managed-by-swarmy' | 'external';
}

/**
 * The map's aside facts: how the servers link (per link once agents report
 * it, else per server: direct, or through the relay) and, at Controls, the
 * driver, where the control plane is and the span of round trips.
 */
export function MeshFacts({
  peers,
  config,
  links,
}: {
  peers: MeshPeerLike[];
  config: MeshConfigLike | undefined;
  links?: MeshLinkLike[];
}): React.JSX.Element | null {
  const split = linkSplit(peers, links);
  const span = latencySpan(links);
  const driver = (config?.driver ?? 'none') as MeshDriverId;
  return (
    <section aria-label="Links" className="calm-card flex flex-col gap-2.5 px-5 py-4">
      {split ? (
        <>
          <span className="calm-eyebrow">{split.per === 'link' ? 'Links' : 'Links · per server'}</span>
          <ul className="flex flex-col gap-1.5 text-[13px]">
            <li className="flex items-center gap-2">
              <span aria-hidden className="bg-tone-mesh h-0.5 w-4 shrink-0" />
              <b className="font-semibold">{split.direct} direct</b>
              <span className="text-muted-foreground ml-auto text-right">peer to peer, no middleman</span>
            </li>
            {split.relayed ? (
              <li className="flex items-center gap-2">
                <span aria-hidden className="border-tone-warn w-4 shrink-0 border-t-2 border-dashed" />
                <b className="font-semibold">{split.relayed} relayed</b>
                <span className="text-muted-foreground ml-auto text-right">still end-to-end encrypted</span>
              </li>
            ) : null}
          </ul>
        </>
      ) : (
        <p className="text-muted-foreground text-[13px]">No server has reported how it links yet.</p>
      )}
      <Depth at="controls">
        <dl className="border-border mt-1 grid grid-cols-[110px_minmax(0,1fr)] gap-x-3 gap-y-1.5 border-t pt-3 text-[13px]">
          <dt className="text-muted-foreground">Driver</dt>
          <dd>{driver === 'netbird' ? 'NetBird (WireGuard)' : DRIVER_LABELS[driver] ?? driver}</dd>
          <dt className="text-muted-foreground">Control plane</dt>
          <dd>{config?.controlPlaneMode === 'managed-by-swarmy' ? 'Managed by swarmy' : 'External'}</dd>
          <dt className="text-muted-foreground">Management</dt>
          <dd className="truncate font-mono text-[12px]">{config?.managementUrl ?? 'not set'}</dd>
          <dt className="text-muted-foreground">Round trips</dt>
          <dd className={span ? 'font-mono text-[12px]' : 'text-muted-foreground'}>{span ?? 'not reported'}</dd>
        </dl>
      </Depth>
    </section>
  );
}
