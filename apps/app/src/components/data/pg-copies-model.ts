/**
 * Board 15's database copies by server: one chip per copy, the writer's
 * draggable onto a standby copy (that offers the planned switchover), the
 * standbys never moved. PURE — tested in pg-copies-model.test.ts.
 */

/** Drag payload types: a cluster's writer (`<stack>/<cluster>`), or a standby (refused). */
export const PG_WRITER_DRAG = 'application/x-swarmy-pg-writer';
export const PG_STANDBY_DRAG = 'application/x-swarmy-pg-standby';

/** Said when a standby copy is dragged: placement is for keeps. */
export const STANDBY_STAYS =
  'Standby copies stay on the server they were placed on: swarmy doesn’t move them. Drag the writer onto one instead to make that copy the writer.';

export interface CopyChip {
  key: string;
  service: string;
  role: 'writer' | 'standby';
  /** The server's id and name, or null while placement loads / when it isn't running. */
  nodeId: string | null;
  server: string | null;
}

interface Member {
  service: string;
  role: string;
  desired: number;
  running: number;
}

/** Every copy of the cluster as a chip (by server; one unplaced chip while placement loads), writers first. */
export function copyChips(members: readonly Member[], place: ReadonlyMap<string, ReadonlyArray<{ id: string; name: string }>> | undefined): CopyChip[] {
  const out: CopyChip[] = [];
  for (const m of members) {
    if ((m.role !== 'primary' && m.role !== 'replica') || (m.desired === 0 && m.running === 0)) continue;
    const role = m.role === 'primary' ? 'writer' : 'standby';
    const servers = place?.get(m.service);
    if (servers && servers.length > 0) {
      for (const n of servers) out.push({ key: `${m.service}@${n.id}`, service: m.service, role, nodeId: n.id, server: n.name });
    } else {
      out.push({ key: `${m.service}@-`, service: m.service, role, nodeId: null, server: null });
    }
  }
  const rank = (c: CopyChip) => (c.role === 'writer' ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || (a.server ?? a.service).localeCompare(b.server ?? b.service));
}

/** The drag key a cluster's writer carries, so a drop on another cluster's copy is ignored. */
export const writerDragKey = (stack: string, cluster: string): string => `${stack}/${cluster}`;
