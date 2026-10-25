import { diskSizeWord, freeDiskBytes, volumeSizeOn, type NodeStatsSnapshot, type NodeSummary, type NodeVolumeSizes } from '@swarmy/core';
import type { Tone } from '@/components/calm';
import type { PgTopoMember } from './pg-topology';

/**
 * The disk line of a Postgres page's Size section (board 39, "Disk 4.1 /
 * 20 GB"): each copy's data volume as its server's agent measured it
 * (`nodes.volumeSizes`) and the free disk on that server (its live sample).
 * A size or a free figure nobody reported reads "not reported" — never a
 * zero. PURE — tested in pg-disk.test.ts.
 */

/** A server this full is worth a word (the Servers page's own threshold). */
export const DISK_FULL_PCT = 80;

export interface DiskCopy {
  key: string;
  server: string;
  main: boolean;
  volume: string;
  /** Bytes on that server; null = not reported. */
  dataBytes: number | null;
  freeBytes: number | null;
  /** How full that server's disk is, 0–100; null = not reported. */
  usedPct: number | null;
}

export function diskCopies(
  members: readonly PgTopoMember[],
  place: Map<string, NodeSummary[]> | undefined,
  reports: readonly NodeVolumeSizes[],
  stats: ReadonlyMap<string, NodeStatsSnapshot | null>,
): DiskCopy[] {
  const out: DiskCopy[] = [];
  for (const m of members) {
    if (m.role === 'dcs' || !m.dataVolume) continue;
    for (const n of place?.get(m.service) ?? []) {
      const size = volumeSizeOn(reports, n.id, m.dataVolume);
      const live = stats.get(n.id) ?? null;
      out.push({
        key: `${m.service}@${n.id}`,
        server: n.name,
        main: m.role === 'primary',
        volume: m.dataVolume,
        dataBytes: typeof size === 'number' ? size : null,
        freeBytes: freeDiskBytes(live),
        usedPct: live?.fsTotalBytes && live.fsUsedBytes != null ? (live.fsUsedBytes / live.fsTotalBytes) * 100 : null,
      });
    }
  }
  return out.sort((a, b) => Number(b.main) - Number(a.main) || a.server.localeCompare(b.server));
}

export interface DiskLine {
  /** "4.1 GB" — the main copy's data. */
  label: string;
  hint: string;
  tone: Tone;
  /** One mono line per copy, Controls up. */
  tech: string[];
}

const free = (c: DiskCopy): string => (c.freeBytes === null ? 'its free disk isn’t reported' : `${diskSizeWord(c.freeBytes)} free`);

export function diskLine(copies: readonly DiskCopy[]): DiskLine | null {
  const main = copies.find((c) => c.main);
  if (!main) return null;
  const full = copies.filter((c) => (c.usedPct ?? 0) >= DISK_FULL_PCT);
  const label = main.dataBytes === null ? 'Size not reported' : diskSizeWord(main.dataBytes);
  const where = `on ${main.server}, which has ${free(main)}`;
  const hint = full.length
    ? `${full.map((c) => `${c.server} is ${Math.round(c.usedPct!)}% full`).join(', ')}. Free some space before the data grows into it.`
    : copies.length > 1
      ? `The main copy’s data, ${where}. Each standby copy keeps its own.`
      : `The data, ${where}.`;
  return {
    label,
    hint: main.dataBytes === null && !full.length ? `${main.server}’s agent hasn’t reported volume sizes yet; ${free(main)}.` : hint,
    tone: full.length ? 'warn' : 'ok',
    tech: copies.map(
      (c) =>
        `${c.server} · ${c.volume} · ${c.dataBytes === null ? 'size not reported' : diskSizeWord(c.dataBytes)} · ${c.freeBytes === null ? 'free not reported' : `${diskSizeWord(c.freeBytes)} free`}${c.usedPct === null ? '' : ` (${Math.round(c.usedPct)}% used)`}`,
    ),
  };
}
