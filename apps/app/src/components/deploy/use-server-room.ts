import * as React from 'react';
import { useFleet } from '@/components/nodes/servers/use-fleet';

export interface ServerRoom {
  id: string;
  name: string;
  /** Free memory from the server's latest live sample. */
  freeBytes: number;
  totalBytes: number;
}

/**
 * Free memory per online server (from each one's latest live sample), roomiest
 * first — the one source for "Lands on …", "Fits on …" and the fit bars.
 */
export function useServerRoom(): { pending: boolean; servers: ServerRoom[]; roomiest: ServerRoom | null } {
  const fleet = useFleet();
  return React.useMemo(() => {
    const servers = fleet.servers
      .filter((s) => s.node.status === 'online' && s.live?.memTotalBytes)
      .map((s) => ({
        id: s.node.id,
        name: s.node.name,
        totalBytes: s.live!.memTotalBytes,
        freeBytes: Math.max(0, s.live!.memTotalBytes - s.live!.memUsedBytes),
      }))
      .sort((a, b) => b.freeBytes - a.freeBytes);
    const waiting = servers.length === 0 && fleet.servers.some((s) => s.node.status === 'online' && !s.live);
    return { pending: fleet.pending || waiting, servers, roomiest: servers[0] ?? null };
  }, [fleet.pending, fleet.servers]);
}

/** True when `needMb` fits in `freeBytes`. */
export function fitsIn(needMb: number | undefined, freeBytes: number): boolean {
  return !needMb || freeBytes >= needMb * 1024 ** 2;
}
