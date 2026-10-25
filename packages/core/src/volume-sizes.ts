/**
 * Volume sizes, pure (boards 9 + 36). The agent turns Docker's
 * `/system/df?type=volume` answer into the wire list (`parseVolumeDf`); the
 * controller serves the latest report per server (`NodeVolumeSizes`) and the
 * Move check and Placement & volumes read sizes out of it.
 */
import { MAX_REPORTED_VOLUMES, type VolumeSizeEntry } from './protocol/volume-sizes';

interface DfVolume {
  Name?: unknown;
  UsageData?: { Size?: unknown; RefCount?: unknown } | null;
}

const count = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined;

/**
 * Docker's `GET /system/df?type=volume` body → each volume's size, largest
 * first, at most `MAX_REPORTED_VOLUMES`. A volume Docker could not size
 * (`Size: -1`, a non-local driver, no `UsageData`) is left out — unknown is
 * never a zero. Anything that is not a df answer gives an empty list.
 */
export function parseVolumeDf(raw: unknown): VolumeSizeEntry[] {
  const vols = (raw as { Volumes?: unknown } | null | undefined)?.Volumes;
  if (!Array.isArray(vols)) return [];
  const out: VolumeSizeEntry[] = [];
  const seen = new Set<string>();
  for (const v of vols as DfVolume[]) {
    const name = typeof v?.Name === 'string' ? v.Name : '';
    const size = count(v?.UsageData?.Size);
    if (!name || name.length > 255 || size === undefined || seen.has(name)) continue;
    seen.add(name);
    const refCount = count(v?.UsageData?.RefCount);
    out.push({ name, sizeBytes: size, ...(refCount !== undefined ? { refCount } : {}) });
  }
  return out.sort((a, b) => b.sizeBytes - a.sizeBytes || a.name.localeCompare(b.name)).slice(0, MAX_REPORTED_VOLUMES);
}

/** One server's latest report, as the controller serves it (`nodes.volumeSizes`). */
export interface NodeVolumeSizes {
  nodeId: string;
  /** When the agent measured; null = it has not reported (an older agent, or not measured yet). */
  sampledAt: number | null;
  volumes: { name: string; sizeBytes: number }[];
}

/** The size of `volume` on `nodeId`: a number, `'unreported'` (no report from that server) or `'absent'` (not in it). */
export function volumeSizeOn(reports: readonly NodeVolumeSizes[], nodeId: string, volume: string): number | 'unreported' | 'absent' {
  const r = reports.find((x) => x.nodeId === nodeId);
  if (!r || r.sampledAt === null) return 'unreported';
  return r.volumes.find((v) => v.name === volume)?.sizeBytes ?? 'absent';
}

/** Every server that reported `volume`, with its size there (an app's per-server copies, a move's old copy). */
export function volumePlaces(reports: readonly NodeVolumeSizes[], volume: string): { nodeId: string; sizeBytes: number }[] {
  const out: { nodeId: string; sizeBytes: number }[] = [];
  for (const r of reports) {
    const v = r.volumes.find((x) => x.name === volume);
    if (v) out.push({ nodeId: r.nodeId, sizeBytes: v.sizeBytes });
  }
  return out;
}
