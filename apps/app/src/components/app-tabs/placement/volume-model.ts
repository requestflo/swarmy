import type { NodeSummary, VolumeMount } from '@swarmy/core';
import { pinnedServer } from '../scaling/scaling-model';
import type { PlacedService } from '../scaling/use-app-placement';

/**
 * Volumes as rows (board AppPlacement): what each part keeps on disk, sorted
 * by what happens to it when a copy moves. A named volume on a pinned part
 * stays with its server (Move… takes it along); a named volume on a part
 * that roams is a fresh, empty one wherever a copy lands; an anonymous
 * volume or tmpfs is thrown away; a host folder is read from the server.
 * PURE — unit-tested in placement-model.test.ts.
 */

export type VolumeKind = 'pinned' | 'roaming' | 'throwaway' | 'host';

export interface VolumeRow {
  kind: VolumeKind;
  key: string;
  serviceId: string;
  /** Docker service name (what a move is asked for). */
  service: string;
  part: string;
  source: string | null;
  target: string;
  readOnly: boolean;
  tmpfs: boolean;
  /** The server a pinned part (and its data) stays on. */
  server: NodeSummary | null;
}

const ORDER: Record<VolumeKind, number> = { pinned: 0, roaming: 1, throwaway: 2, host: 3 };

export function volumeRows(stack: string, rows: PlacedService[], nodes: NodeSummary[]): VolumeRow[] {
  const out: VolumeRow[] = [];
  for (const { inv, detail } of rows) {
    const part = inv.name.startsWith(`${stack}_`) ? inv.name.slice(stack.length + 1) : inv.name;
    const pin = pinnedServer(detail, nodes) ?? null;
    for (const v of detail?.volumes ?? []) {
      const source = v.source || null;
      const tmpfs = v.type === 'tmpfs';
      const kind: VolumeKind = v.type === 'bind' ? 'host' : tmpfs || !source ? 'throwaway' : pin ? 'pinned' : 'roaming';
      out.push({ kind, key: `${inv.id}:${v.target}`, serviceId: inv.id, service: inv.name, part, source, target: v.target, readOnly: v.readOnly, tmpfs, server: kind === 'pinned' ? pin : null });
    }
  }
  return out.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.part.localeCompare(b.part));
}

/** `storefront_web-app-cache` for `/app/.cache` on web: a name that says whose and what. */
export function durableName(stack: string, part: string, target: string): string {
  const slug = target.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'data';
  return `${stack}_${part}-${slug}`.slice(0, 63);
}

/** The full mount list with one anonymous volume given a name (services.update replaces the list). */
export function withDurable(volumes: Array<{ type: string; source?: string; target: string; readOnly: boolean }>, target: string, name: string): VolumeMount[] {
  return volumes.map((v) => ({
    type: v.type === 'bind' ? 'bind' : v.type === 'tmpfs' ? 'tmpfs' : 'volume',
    ...(v.target === target && !v.source && v.type !== 'tmpfs' ? { source: name } : v.source ? { source: v.source } : {}),
    target: v.target,
    readOnly: v.readOnly,
  }));
}
