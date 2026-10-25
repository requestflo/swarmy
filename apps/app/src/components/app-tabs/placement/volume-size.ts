import { diskSizeWord, volumePlaces, volumeSizeOn, type NodeSummary, type NodeVolumeSizes } from '@swarmy/core';
import type { VolumeRow } from './volume-model';

/**
 * How big a volume row is and where (board AppPlacement: "db-data · pinned ·
 * london-2 · 4.1 GB"), from the agents' reports (`nodes.volumeSizes`).
 * PURE — unit-tested in placement-model.test.ts. A pinned volume is read on
 * its server; a roaming one on every server that has a copy. A server whose
 * agent predates the report, or a volume not in one, is "size not reported"
 * — never a zero.
 */

export type VolumeSize =
  | { kind: 'known'; places: { server: NodeSummary; bytes: number }[]; sampledAt: number }
  | { kind: 'unreported' };

export function volumeSize(row: VolumeRow, reports: readonly NodeVolumeSizes[], nodes: readonly NodeSummary[]): VolumeSize | null {
  if ((row.kind !== 'pinned' && row.kind !== 'roaming') || !row.source) return null;
  const source = row.source;
  const at = (nodeId: string) => reports.find((r) => r.nodeId === nodeId)?.sampledAt ?? 0;
  if (row.kind === 'pinned' && row.server) {
    const bytes = volumeSizeOn(reports, row.server.id, source);
    return typeof bytes === 'number' ? { kind: 'known', places: [{ server: row.server, bytes }], sampledAt: at(row.server.id) } : { kind: 'unreported' };
  }
  const places = volumePlaces(reports, source)
    .map((p) => ({ server: nodes.find((n) => n.id === p.nodeId), bytes: p.sizeBytes }))
    .filter((p): p is { server: NodeSummary; bytes: number } => !!p.server)
    .sort((a, b) => a.server.name.localeCompare(b.server.name));
  if (places.length === 0) return { kind: 'unreported' };
  return { kind: 'known', places, sampledAt: Math.max(...places.map((p) => at(p.server.id))) };
}

/** "4.2 GB on wkr-1" · "1.2 GB on wkr-1, 640 MB on wkr-2" · "size not reported". */
export function sizeWords(size: VolumeSize): string {
  if (size.kind === 'unreported') return 'size not reported';
  const shown = size.places.slice(0, 3).map((p) => `${diskSizeWord(p.bytes)} on ${p.server.name}`);
  const more = size.places.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
}

/** The pinned and roaming sentences, with the size first (board AppPlacement's row). */
export function volumeSay(row: VolumeRow, size: VolumeSize | null | undefined): string {
  const known = size?.kind === 'known';
  if (row.kind === 'pinned') {
    const base = `${row.part} follows its data.`;
    if (known) return `${sizeWords(size)}; ${base}`;
    return `Stays on ${row.server?.name ?? 'its server'}; ${base}${size ? ' Size not reported.' : ''}`;
  }
  const base = `a copy that moves starts with an empty one.`;
  if (known) return `Kept on whichever server runs ${row.part} (${sizeWords(size)}): ${base}`;
  return `Kept on whichever server runs ${row.part}: ${base}${size ? ' Size not reported.' : ''}`;
}
