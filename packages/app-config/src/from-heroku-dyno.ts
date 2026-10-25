/**
 * Heroku dyno sizes → swarmy resource limits, for {@link fromHeroku}. Pure.
 *
 * A dyno is a memory size plus a CPU share. swarmy sets a hard memory limit
 * and a CPU limit on every copy of a service, so the memory carries over
 * exactly. Shared dynos take the swarmy size preset with the same memory;
 * dedicated dynos (Performance, Private, Shield) keep their vCPU count.
 * Formation `quantity` is the number of copies (`replicas:`).
 *
 * | Heroku dyno                                   | Memory  | swarmy.yaml                       |
 * |-----------------------------------------------|---------|-----------------------------------|
 * | eco, basic, standard-1x (and free, hobby)     | 512 MB  | `size: small` (0.5 CPU, 512 MB)   |
 * | standard-2x, private-s, shield-s              | 1 GB    | `size: medium` (1 CPU, 1 GB)      |
 * | performance-m, private-m, shield-m            | 2.5 GB  | `memory: 2560mb`, `cpu: 2`        |
 * | performance-l, private-l, shield-l            | 14 GB   | `memory: 14gb`, `cpu: 8`          |
 * | performance-l-ram, private-l-ram, shield-l-ram | 30 GB  | `memory: 30gb`, `cpu: 4`          |
 * | performance-xl, private-xl, shield-xl         | 62 GB   | `memory: 62gb`, `cpu: 8`          |
 * | performance-2xl, private-2xl, shield-2xl      | 126 GB  | `memory: 126gb`, `cpu: 16`        |
 *
 * The same table is in the docs (guides/import-from-heroku); keep them equal.
 */

export interface DynoShape {
  memoryMb: number;
  /** Dedicated vCPUs; shared dynos have none (the preset's CPU applies). */
  cpu?: number;
}

const SHARED_512: DynoShape = { memoryMb: 512 };
const SHARED_1G: DynoShape = { memoryMb: 1024 };
const tier = (memoryMb: number, cpu: number, ...names: string[]): Array<[string, DynoShape]> =>
  names.map((n) => [n, { memoryMb, cpu }]);

/** Every dyno size swarmy maps, lower-case as `heroku ps` and the Platform API spell them. */
export const DYNO_SIZES: Readonly<Record<string, DynoShape>> = Object.fromEntries([
  ...['free', 'eco', 'hobby', 'basic', 'standard-1x'].map((n) => [n, SHARED_512] as [string, DynoShape]),
  ...['standard-2x', 'private-s', 'shield-s'].map((n) => [n, SHARED_1G] as [string, DynoShape]),
  ...tier(2560, 2, 'performance-m', 'private-m', 'shield-m'),
  ...tier(14336, 8, 'performance-l', 'private-l', 'shield-l'),
  ...tier(30720, 4, 'performance-l-ram', 'private-l-ram', 'shield-l-ram'),
  ...tier(63488, 8, 'performance-xl', 'private-xl', 'shield-xl'),
  ...tier(129024, 16, 'performance-2xl', 'private-2xl', 'shield-2xl'),
]);

export type DynoLimits = { size: 'small' | 'medium' } | { memory: string; cpu: number };

/** A dyno size as swarmy.yaml keys (`Standard-2X` → `size: medium`), or null when unknown. */
export function dynoSize(size: string): DynoLimits | null {
  const d = DYNO_SIZES[size.trim().toLowerCase()];
  if (!d) return null;
  if (d.cpu === undefined) return { size: d.memoryMb === 512 ? 'small' : 'medium' };
  return { memory: d.memoryMb % 1024 === 0 ? `${d.memoryMb / 1024}gb` : `${d.memoryMb}mb`, cpu: d.cpu };
}

/** `size: medium` · `memory: 2560mb, cpu: 2` — how a change line says it. */
export function dynoLimitsText(l: DynoLimits): string {
  return 'size' in l ? `size: ${l.size}` : `memory: ${l.memory}, cpu: ${l.cpu}`;
}
