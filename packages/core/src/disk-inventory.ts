/**
 * "Add a disk" (plans/epic-volume-mobility.md, phase 1) — the PURE half.
 *
 * The agent runs `lsblk -J -b -o NAME,PATH,SIZE,TYPE,FSTYPE,MOUNTPOINTS,
 * SERIAL,MODEL,RO,RM,PTTYPE` and ships the JSON; {@link classifyDisks} turns it
 * into one line per whole disk with the only action swarmy may offer on it.
 * {@link formatGate} is the last check the agent runs immediately before
 * `mkfs` — it is deliberately paranoid: anything that is not provably an
 * empty, unmounted, writable, fixed disk with the serial the operator
 * confirmed is refused. Swarmy never formats a disk that has any signature,
 * and never formats on its own.
 */

/** One `lsblk -J` node (old lsblk has `mountpoint`, new has `mountpoints`). */
export interface LsblkDevice {
  name: string;
  path?: string;
  size?: number | string;
  type?: string;
  fstype?: string | null;
  mountpoint?: string | null;
  mountpoints?: (string | null)[];
  serial?: string | null;
  model?: string | null;
  ro?: boolean | string | number;
  rm?: boolean | string | number;
  pttype?: string | null;
  children?: LsblkDevice[];
}

export type DiskState =
  /** Whole disk, no partitions/FS/partition table, not mounted: may be formatted. */
  | 'blank'
  /** Has a filesystem, partitions or a partition table: never format — mount as-is at most. */
  | 'has-data'
  /** Mounted by swarmy under {@link SWARMY_DISK_ROOT}. */
  | 'swarmy'
  /** Mounted elsewhere (not a system path): leave alone. */
  | 'mounted'
  /** Holds /, /boot, swap, /var/lib/docker…: never touch. */
  | 'system'
  /** Read-only, removable or too small to be worth it. */
  | 'ineligible';

export interface DiskView {
  name: string;
  path: string;
  sizeBytes: number;
  serial: string | null;
  model: string | null;
  state: DiskState;
  /** Every mountpoint on the disk or its partitions. */
  mountpoints: string[];
  /** Filesystem signature on the whole disk, when there is one. */
  fstype: string | null;
  /** Plain-words reason for the state (Summary layer). */
  reason: string;
}

/** Where swarmy mounts disks it formatted: `/mnt/swarmy/<fs-uuid>`. */
export const SWARMY_DISK_ROOT = '/mnt/swarmy/';
/** Smaller than this is not worth offering. */
export const MIN_DISK_BYTES = 1024 ** 3;
const SYSTEM_MOUNTS = new Set(['/', '/boot', '/boot/efi', '/usr', '/var', '/var/lib/docker', '/home', '[SWAP]']);
/** Whole-disk device types lsblk reports for attachable block storage. */
const DISK_TYPES = new Set(['disk']);

function truthy(v: boolean | string | number | undefined): boolean {
  return v === true || v === 1 || v === '1' || v === 'true';
}

function mountsOf(d: LsblkDevice): string[] {
  const own = [...(d.mountpoints ?? []), d.mountpoint ?? null].filter((m): m is string => Boolean(m));
  return [...own, ...(d.children ?? []).flatMap(mountsOf)];
}

function anyFs(d: LsblkDevice): boolean {
  return Boolean(d.fstype) || (d.children ?? []).some(anyFs);
}

/** Parse `lsblk -J` output (string or parsed). Unknown shapes ⇒ []. */
export function parseLsblk(json: string | unknown): LsblkDevice[] {
  let v: unknown = json;
  if (typeof json === 'string') {
    try {
      v = JSON.parse(json);
    } catch {
      return [];
    }
  }
  const list = (v as { blockdevices?: unknown })?.blockdevices;
  return Array.isArray(list) ? (list as LsblkDevice[]).filter((d) => d && typeof d.name === 'string') : [];
}

/** One view per whole disk (loop/rom/zram and partitions are not listed on their own). */
export function classifyDisks(devices: readonly LsblkDevice[]): DiskView[] {
  return devices
    .filter((d) => DISK_TYPES.has(d.type ?? ''))
    .map((d) => {
      const mountpoints = mountsOf(d);
      const sizeBytes = Number(d.size ?? 0) || 0;
      const base = {
        name: d.name,
        path: d.path ?? `/dev/${d.name}`,
        sizeBytes,
        serial: d.serial?.trim() || null,
        model: d.model?.trim() || null,
        mountpoints,
        fstype: d.fstype ?? null,
      };
      const swap = d.fstype === 'swap' || (d.children ?? []).some((c) => c.fstype === 'swap');
      if (swap || mountpoints.some((m) => SYSTEM_MOUNTS.has(m))) {
        return { ...base, state: 'system' as const, reason: 'Holds the operating system, swap or Docker itself.' };
      }
      if (mountpoints.length > 0 && mountpoints.every((m) => m.startsWith(SWARMY_DISK_ROOT))) {
        return { ...base, state: 'swarmy' as const, reason: 'In use by swarmy for app data.' };
      }
      if (mountpoints.length > 0) {
        return { ...base, state: 'mounted' as const, reason: `Already mounted at ${mountpoints.join(', ')}.` };
      }
      if (anyFs(d) || d.pttype || (d.children ?? []).length > 0) {
        return {
          ...base,
          state: 'has-data' as const,
          reason: d.fstype
            ? `Has a ${d.fstype} filesystem — it may hold data, so swarmy will not format it.`
            : 'Has partitions — it may hold data, so swarmy will not format it.',
        };
      }
      if (truthy(d.ro) || truthy(d.rm)) {
        return { ...base, state: 'ineligible' as const, reason: 'Read-only or removable.' };
      }
      if (sizeBytes < MIN_DISK_BYTES) {
        return { ...base, state: 'ineligible' as const, reason: 'Smaller than 1 GB.' };
      }
      return { ...base, state: 'blank' as const, reason: 'New and empty — it can be formatted and used for app data.' };
    });
}

export type FormatGate = { ok: true } | { ok: false; reason: string };

/**
 * The agent's final check right before `mkfs`. `devices` is a FRESH lsblk,
 * `wipefsOutput` is `wipefs -n <path>` stdout (any line = a signature), and
 * `expected` is what the operator confirmed in the dashboard. Pure.
 */
export function formatGate(input: {
  devices: readonly LsblkDevice[];
  expected: { path: string; serial: string; sizeBytes: number };
  wipefsOutput: string;
  /** The last 4 characters of the serial, as typed by the operator. */
  typedConfirmation: string;
}): FormatGate {
  const { expected } = input;
  if (!expected.serial || expected.serial.length < 4) {
    return { ok: false, reason: 'The disk has no serial number, so swarmy cannot be sure it is the same disk. Format it by hand.' };
  }
  const disk = classifyDisks(input.devices).find((d) => d.path === expected.path);
  if (!disk) return { ok: false, reason: `${expected.path} is no longer present.` };
  if (disk.serial !== expected.serial) {
    return { ok: false, reason: `${expected.path} is now a different disk (serial changed) — device names can move after a reboot.` };
  }
  if (disk.sizeBytes !== expected.sizeBytes) {
    return { ok: false, reason: `${expected.path} changed size since you confirmed it.` };
  }
  if (disk.state !== 'blank') return { ok: false, reason: disk.reason };
  if (input.wipefsOutput.trim().length > 0) {
    return { ok: false, reason: 'A filesystem or partition signature was found on the disk — it may hold data, so it will not be formatted.' };
  }
  if (input.typedConfirmation.trim().toUpperCase() !== expected.serial.slice(-4).toUpperCase()) {
    return { ok: false, reason: 'The confirmation does not match the last 4 characters of the disk serial.' };
  }
  return { ok: true };
}

/**
 * A swarmy disk the owner grew in the cloud console: the block device is
 * bigger than its filesystem. Grow (resize2fs/xfs_growfs) is online and cannot
 * lose data, so it is offered with one click. Pure.
 */
export function growableBytes(disk: DiskView, fsTotalBytes: number | undefined): number {
  if (disk.state !== 'swarmy' || !fsTotalBytes) return 0;
  const extra = disk.sizeBytes - fsTotalBytes;
  // Filesystems reserve metadata; only offer growth past 2% and 1 GiB.
  return extra > Math.max(MIN_DISK_BYTES, disk.sizeBytes * 0.02) ? extra : 0;
}
