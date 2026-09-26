/**
 * "Add a disk" (plans/epic-volume-mobility.md, phase 1): list the server's
 * block devices, format + mount a blank one (ext4), grow a swarmy disk the
 * owner enlarged in the cloud console.
 *
 * All three run on the HOST — natively for the binary agent (root), through a
 * one-shot `--pid host --privileged` nsenter container for the container agent.
 * `formatDisk` is gated twice on the agent: the node capability
 * (`swarmy.node.diskFormat`, asserted as `nodeCapable`, with the local
 * `SWARMY_ALLOW_DISK_FORMAT` override) and `formatGate` on a fresh probe
 * (serial, size, blank, no signature, typed last-4 of the serial).
 */
import { z } from 'zod';
import { CommandId } from './primitives';

const cmd = { commandId: CommandId, timeoutMs: z.number().int().positive().optional() };

export const ListDisksPayload = z.object({ ...cmd });
export type ListDisksPayload = z.infer<typeof ListDisksPayload>;
export const ListDisksMsg = z.object({ type: z.literal('listDisks'), payload: ListDisksPayload });
export type ListDisksMsg = z.infer<typeof ListDisksMsg>;

const DevicePath = z
  .string()
  .regex(/^\/dev\/[A-Za-z0-9._/-]+$/, 'invalid device path')
  .refine((p) => !p.includes('..'), 'invalid device path');

export const FormatDiskPayload = z.object({
  ...cmd,
  /** Device path the operator saw (`/dev/sdb`). Names can move; the serial is what counts. */
  path: DevicePath,
  serial: z.string().min(4).max(128),
  sizeBytes: z.number().int().positive(),
  /** Last 4 characters of the serial, typed by the operator. */
  typedConfirmation: z.string().min(1).max(16),
  /** ext4 only (owner decision 2026-09-25). */
  fstype: z.literal('ext4').default('ext4'),
  /** Controller's read of `swarmy.node.diskFormat` (absent label ⇒ true). Absent ⇒ refused. */
  nodeCapable: z.boolean().optional(),
});
export type FormatDiskPayload = z.infer<typeof FormatDiskPayload>;
export const FormatDiskMsg = z.object({ type: z.literal('formatDisk'), payload: FormatDiskPayload });
export type FormatDiskMsg = z.infer<typeof FormatDiskMsg>;

export const GrowDiskPayload = z.object({ ...cmd, serial: z.string().min(1).max(128) });
export type GrowDiskPayload = z.infer<typeof GrowDiskPayload>;
export const GrowDiskMsg = z.object({ type: z.literal('growDisk'), payload: GrowDiskPayload });
export type GrowDiskMsg = z.infer<typeof GrowDiskMsg>;

/**
 * Re-attach a swarmy disk that is formatted but not mounted on the host
 * (QA-075b). The agent waits (up to `waitMs`) until no running container uses
 * the disk, else `E_DISK_BUSY`; then runs the repair script, which copies
 * anything already written into the bare mountpoint onto the disk, verifies
 * it, keeps the originals aside and mounts the disk. Never deletes data.
 */
export const RepairDiskPayload = z.object({
  ...cmd,
  path: DevicePath,
  serial: z.string().min(1).max(128),
  /** Suffix of the set-aside directory (`<mnt>.pre-mount-<stamp>`). */
  stamp: z.string().regex(/^[0-9A-Za-z-]{1,32}$/),
  /** How long to wait for the containers using the disk to stop. */
  waitMs: z.number().int().nonnegative().max(600_000).default(120_000),
  /** Controller's read of `swarmy.node.diskRepair` (absent label ⇒ true). */
  nodeCapable: z.boolean().optional(),
});
export type RepairDiskPayload = z.infer<typeof RepairDiskPayload>;
export const RepairDiskMsg = z.object({ type: z.literal('repairDisk'), payload: RepairDiskPayload });
export type RepairDiskMsg = z.infer<typeof RepairDiskMsg>;

/** One whole disk (the `DiskEntry` shape from `@swarmy/core` disk-inventory). */
export const DiskEntryWire = z.object({
  name: z.string(),
  path: z.string(),
  sizeBytes: z.number(),
  serial: z.string().nullable(),
  model: z.string().nullable(),
  state: z.enum(['blank', 'has-data', 'swarmy', 'swarmy-unmounted', 'mounted', 'system', 'ineligible']),
  mountpoints: z.array(z.string()),
  fstype: z.string().nullable(),
  /** Filesystem label (older agents omit it). */
  label: z.string().nullable().optional(),
  reason: z.string(),
  id: z.string().nullable(),
  fsTotalBytes: z.number().nullable(),
  growableBytes: z.number(),
  /**
   * `swarmy-unmounted` only (QA-075b): what was written into the bare
   * mountpoint directory on the ROOT disk while the disk was not attached, and
   * the apps (swarm service names, else container names) using volumes there.
   */
  pending: z
    .object({
      files: z.number(),
      bytes: z.number(),
      services: z.array(z.string()),
      /** Of `services`, those with a RUNNING container on the disk right now. */
      running: z.array(z.string()).optional(),
    })
    .optional(),
});
export type DiskEntryWire = z.infer<typeof DiskEntryWire>;

export interface ListDisksResult {
  disks: DiskEntryWire[];
  /** The box's `SWARMY_ALLOW_DISK_FORMAT` override, when set. */
  localOverride?: 'allow' | 'deny';
}

export interface FormatDiskResult {
  serial: string;
  id: string;
  mountpoint: string;
  uuid: string;
  sizeBytes: number;
}

export interface GrowDiskResult {
  serial: string;
  mountpoint: string;
  fsTotalBytes: number;
}

export interface RepairDiskResult {
  serial: string;
  id: string;
  mountpoint: string;
  /** It was already mounted on the host: nothing was done. */
  alreadyMounted: boolean;
  uuid: string | null;
  /** Files were copied from the root disk onto the disk. */
  moved: boolean;
  files: number;
  bytes: number;
  /** Where the originals were kept on the root disk, when moved. */
  aside: string | null;
}
