import type { ServiceUsageView } from '@swarmy/core';
import { MIB, fmtCpu, sayMem, type SettingsDraft } from '@/components/service-settings/settings-model';

/**
 * Size of each copy (board AppScaling): the swarmy.yaml `size` presets,
 * applied as CPU + memory limits through `services.update` (the same draft
 * the service settings panel builds). PURE — unit-tested in size-model.test.ts.
 */

/** Mirrors `SIZE_PRESETS` in packages/app-config (the swarmy.yaml `size` key). */
export const SIZES = {
  nano: { cpu: 0.25, memoryMb: 256 },
  small: { cpu: 0.5, memoryMb: 512 },
  medium: { cpu: 1, memoryMb: 1024 },
  large: { cpu: 2, memoryMb: 2048 },
  xlarge: { cpu: 4, memoryMb: 4096 },
} as const;
export type SizeName = keyof typeof SIZES;
export const SIZE_NAMES = Object.keys(SIZES) as SizeName[];

export interface Limits {
  cpus?: number;
  memoryBytes?: number;
}

export const sizeBytes = (s: SizeName): number => SIZES[s].memoryMb * MIB;

/** The preset these limits are exactly, if any. */
export function sizeOf(limits: Limits | undefined): SizeName | null {
  if (!limits) return null;
  return SIZE_NAMES.find((s) => SIZES[s].cpu === limits.cpus && sizeBytes(s) === limits.memoryBytes) ?? null;
}

/** The draft a preset makes (CPU + memory limit per copy). */
export function sizeDraft(s: SizeName): SettingsDraft {
  return { cpuLimit: SIZES[s].cpu, memLimit: sizeBytes(s) };
}

/** "0.5 CPU · 512 MB" — or what's set when only one is. */
export function sizeWords(limits: Limits | undefined): string {
  const parts = [
    limits?.cpus !== undefined ? `${fmtCpu(limits.cpus)} CPU` : null,
    limits?.memoryBytes !== undefined ? sayMem(limits.memoryBytes) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'no ceiling';
}

/** The plain sentence for the size block. */
export function sizeSentence(limits: Limits | undefined, usage: ServiceUsageView | null | undefined): string {
  const name = sizeOf(limits);
  const cap =
    limits?.cpus === undefined && limits?.memoryBytes === undefined
      ? 'No ceiling: each copy can use as much of its server as it likes.'
      : `Each copy can use up to ${sizeWords(limits)}${name ? ` (${name})` : ''}.`;
  if (!usage) return cap;
  return `${cap} The busiest uses ${sayMem(usage.memBytes.peak)} now.`;
}

/** A preset whose memory is below what the busiest copy uses right now. */
export function tooSmall(s: SizeName, usage: ServiceUsageView | null | undefined): boolean {
  return !!usage && sizeBytes(s) < usage.memBytes.peak;
}

/** The swarmy.yaml fields for these limits: `size` when it is a preset, else `cpu` / `memory`. */
export function sizeYaml(limits: Limits | undefined): { size?: SizeName; cpu?: number; memory?: string } {
  const name = sizeOf(limits);
  if (name) return { size: name };
  return {
    ...(limits?.cpus !== undefined ? { cpu: limits.cpus } : {}),
    ...(limits?.memoryBytes !== undefined ? { memory: `${Math.round(limits.memoryBytes / MIB)}mb` } : {}),
  };
}
