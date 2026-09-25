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

/** Where swarmy mounts disks it formatted: `/var/lib/swarmy/disks/<serial>`. */
export const SWARMY_DISK_ROOT = '/var/lib/swarmy/disks/';
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

// ── Phase 1 end to end: ids, labels, placement, host scripts ─────────────────

/** Node label prefix: `swarmy.disk.<id>=<mountpoint>` for every disk swarmy formatted. */
export const DISK_LABEL_PREFIX = 'swarmy.disk.';
/** Node label naming the disk new volumes go on: `swarmy.disk.default=<id>`. */
export const DISK_DEFAULT_LABEL = 'swarmy.disk.default';
/**
 * Per-node opt-out for disk formatting. Formatting is ON by default (owner
 * decision 2026-09-25); `swarmy.node.diskFormat=false` turns it off for one
 * server, and `SWARMY_ALLOW_DISK_FORMAT` on the box is a local tri-state
 * override (like `SWARMY_ALLOW_EXEC`).
 */
export const NODE_DISK_FORMAT_LABEL = 'swarmy.node.diskFormat';

type Override = 'allow' | 'deny' | undefined;

/** Controller-side: may this node format a disk? Local override wins; else the label (absent = allowed). */
export function isDiskFormatCapable(labels: Record<string, string> | undefined, override: Override): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return labels?.[NODE_DISK_FORMAT_LABEL] !== 'false';
}

/**
 * Agent-side gate for `formatDisk`: the local override wins; otherwise the
 * controller must have asserted `nodeCapable === true` (it read the node
 * label at dispatch). Absent assertion ⇒ refuse: formatting fails closed.
 */
export function diskFormatGateAllows(override: Override, nodeCapable: boolean | undefined): boolean {
  if (override === 'deny') return false;
  if (override === 'allow') return true;
  return nodeCapable === true;
}

const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
const SAFE_VOLUME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/;

/** A disk's stable id (path segment + label suffix) from its serial. Throws when nothing usable is left. */
export function diskId(serial: string): string {
  let id = serial.trim().replace(/[^A-Za-z0-9_.-]/g, '_').replace(/^[.-]+/, '').slice(0, 64);
  if (id === 'default') id = 'disk-default';
  if (!SAFE_ID.test(id)) throw new Error('the disk serial has no usable characters');
  return id;
}

/** `/var/lib/swarmy/disks/<id>` — where a formatted disk is mounted. */
export function diskMountpoint(serial: string): string {
  return `${SWARMY_DISK_ROOT}${diskId(serial)}`;
}

/** Labels to stamp on the node once `serial` is formatted and mounted. The first disk becomes the default. */
export function diskLabelsAfterFormat(serial: string, current: Record<string, string> | undefined): Record<string, string> {
  const id = diskId(serial);
  const out: Record<string, string> = { [`${DISK_LABEL_PREFIX}${id}`]: diskMountpoint(serial) };
  if (!defaultDiskMount(current)) out[DISK_DEFAULT_LABEL] = id;
  return out;
}

/** The disks a node's labels declare. Malformed entries are ignored. */
export function nodeDisks(labels: Record<string, string> | undefined): { id: string; mountpoint: string; isDefault: boolean }[] {
  const def = labels?.[DISK_DEFAULT_LABEL];
  return Object.entries(labels ?? {})
    .filter(([k]) => k.startsWith(DISK_LABEL_PREFIX) && k !== DISK_DEFAULT_LABEL)
    .map(([k, v]) => ({ id: k.slice(DISK_LABEL_PREFIX.length), mountpoint: v }))
    .filter((d) => SAFE_ID.test(d.id) && d.mountpoint === `${SWARMY_DISK_ROOT}${d.id}`)
    .map((d) => ({ ...d, isDefault: d.id === def }));
}

/** Mountpoint of the node's default data disk, or null. */
export function defaultDiskMount(labels: Record<string, string> | undefined): string | null {
  return nodeDisks(labels).find((d) => d.isDefault)?.mountpoint ?? null;
}

/**
 * `local`-driver options that put a NEW named volume on the node's default
 * disk (`type=none,o=bind,device=<mount>/volumes/<name>`), or null when the
 * node has none. The volume keeps its name, so no service spec changes.
 */
export function diskVolumeOptions(
  labels: Record<string, string> | undefined,
  volumeName: string,
): { type: 'none'; o: 'bind'; device: string } | null {
  const mount = defaultDiskMount(labels);
  if (!mount || !SAFE_VOLUME.test(volumeName)) return null;
  return { type: 'none', o: 'bind', device: `${mount}/volumes/${volumeName}` };
}

const DISK_DEVICE = /^\/var\/lib\/swarmy\/disks\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,63})\/volumes\/([A-Za-z0-9][A-Za-z0-9_.-]{0,254})$/;

/** Parse a bind device swarmy placed on a disk. Anything else (incl. `..`) ⇒ null. */
export function parseDiskVolumeDevice(device: string): { id: string; mountpoint: string; volume: string } | null {
  const m = DISK_DEVICE.exec(device);
  if (!m || m[2] === '.' || m[2] === '..') return null;
  return { id: m[1]!, mountpoint: `${SWARMY_DISK_ROOT}${m[1]}`, volume: m[2]! };
}

/** POSIX single-quote a value for a host script. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

const LSBLK_COLS = 'NAME,PATH,SIZE,TYPE,FSTYPE,SERIAL,MODEL,RO,RM,PTTYPE';
const DEV_PATH = /^\/dev\/[A-Za-z0-9._/-]+$/;

/**
 * Host script: lsblk JSON, the size of every swarmy mount, and (for `path`)
 * the `wipefs -n` + `blkid -p` signature probe `formatGate` needs. Sections
 * are separated by marker lines; {@link parseDiskProbe} reads them back.
 */
export function renderDiskProbeScript(path?: string): string {
  if (path !== undefined && (!DEV_PATH.test(path) || path.includes('..'))) throw new Error('bad device path');
  const lines = [
    'set -u',
    'command -v lsblk >/dev/null 2>&1 || { echo "__SWARMY_ERR__ lsblk is not installed on this server"; exit 3; }',
    'echo __SWARMY_LSBLK__',
    // util-linux < 2.37 has no MOUNTPOINTS column.
    `lsblk -J -b -o ${LSBLK_COLS},MOUNTPOINTS 2>/dev/null || lsblk -J -b -o ${LSBLK_COLS},MOUNTPOINT`,
    'echo __SWARMY_DF__',
    `df -Pk 2>/dev/null | awk 'NR>1 && index($6,"${SWARMY_DISK_ROOT}")==1 {print $6, $2*1024}'`,
  ];
  if (path) {
    lines.push(
      'echo __SWARMY_WIPEFS__',
      `wipefs -n ${shQuote(path)} 2>&1`,
      'echo __SWARMY_BLKID__',
      `blkid -p ${shQuote(path)} 2>/dev/null; echo "__SWARMY_BLKID_RC__ $?"`,
    );
  }
  return lines.join('\n') + '\n';
}

export interface DiskProbe {
  devices: LsblkDevice[];
  /** Filesystem size by swarmy mountpoint (from `df`). */
  fsTotalBytes: Record<string, number>;
  /** `wipefs -n` output plus any `blkid -p` hit — empty means no signature. */
  signatures?: string;
  error?: string;
}

function section(out: string, marker: string, next: string[]): string | undefined {
  const at = out.indexOf(`${marker}\n`);
  if (at < 0) return undefined;
  const rest = out.slice(at + marker.length + 1);
  const ends = next.map((n) => rest.indexOf(n)).filter((i) => i >= 0);
  return ends.length ? rest.slice(0, Math.min(...ends)) : rest;
}

/** Read {@link renderDiskProbeScript}'s output. Pure. */
export function parseDiskProbe(out: string): DiskProbe {
  const err = /__SWARMY_ERR__ (.*)/.exec(out)?.[1];
  const lsblk = section(out, '__SWARMY_LSBLK__', ['__SWARMY_DF__']) ?? '';
  const df = section(out, '__SWARMY_DF__', ['__SWARMY_WIPEFS__']) ?? '';
  const fsTotalBytes: Record<string, number> = {};
  for (const line of df.split('\n')) {
    const [mount, size] = line.trim().split(/\s+/);
    if (mount && size && Number.isFinite(Number(size))) fsTotalBytes[mount] = Number(size);
  }
  const probe: DiskProbe = { devices: parseLsblk(lsblk.trim()), fsTotalBytes, ...(err ? { error: err } : {}) };
  const wipefs = section(out, '__SWARMY_WIPEFS__', ['__SWARMY_BLKID__']);
  if (wipefs !== undefined) {
    const blkid = section(out, '__SWARMY_BLKID__', ['__SWARMY_BLKID_RC__']) ?? '';
    const rc = /__SWARMY_BLKID_RC__ (\d+)/.exec(out)?.[1];
    // blkid -p: 0 = found a signature, 2 = nothing found; anything else is unknown ⇒ refuse.
    const blkidHit = rc === '2' ? '' : blkid.trim() || `blkid -p exited ${rc ?? 'without a status'}`;
    probe.signatures = [wipefs.trim(), blkidHit].filter(Boolean).join('\n');
  }
  return probe;
}

/** One disk as the dashboard shows it: the classifier view plus filesystem size and room to grow. */
export interface DiskEntry extends DiskView {
  id: string | null;
  fsTotalBytes: number | null;
  growableBytes: number;
}

/** Classifier + df → {@link DiskEntry}. Pure. */
export function diskEntries(probe: DiskProbe): DiskEntry[] {
  return classifyDisks(probe.devices).map((d) => {
    const mount = d.mountpoints.find((m) => m.startsWith(SWARMY_DISK_ROOT));
    const fs = mount ? probe.fsTotalBytes[mount] : undefined;
    let id: string | null = null;
    try {
      id = d.serial ? diskId(d.serial) : null;
    } catch {
      id = null;
    }
    return { ...d, id, fsTotalBytes: fs ?? null, growableBytes: growableBytes(d, fs) };
  });
}

/**
 * Host script that formats ONE disk ext4 and mounts it. It re-checks, in the
 * same shell and immediately before `mkfs`, everything `formatGate` checked
 * (serial, size, no signature, not mounted), so nothing can change between
 * the gate and the format. Mounted by UUID with `nofail` so a missing disk
 * never blocks boot.
 */
export function renderFormatScript(input: { path: string; serial: string; sizeBytes: number }): string {
  if (!DEV_PATH.test(input.path) || input.path.includes('..')) throw new Error('bad device path');
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new Error('bad size');
  const id = diskId(input.serial);
  const mnt = diskMountpoint(input.serial);
  const label = `swarmy-${id.slice(-9)}`;
  return `set -eu
err() { echo "__SWARMY_ERR__ $*"; exit 3; }
DEV=${shQuote(input.path)}
WANT=${shQuote(input.serial.trim())}
MNT=${shQuote(mnt)}
[ -b "$DEV" ] || err "$DEV is not a block device"
HAVE=$(lsblk -dn -o SERIAL "$DEV" | sed 's/^ *//;s/ *$//')
[ "$HAVE" = "$WANT" ] || err "$DEV is now a different disk (serial changed)"
[ "$(lsblk -dn -b -o SIZE "$DEV" | tr -d ' ')" = "${input.sizeBytes}" ] || err "$DEV changed size"
[ -z "$(lsblk -nr -o MOUNTPOINT "$DEV" | tr -d '[:space:]')" ] || err "$DEV is mounted"
[ "$(lsblk -nr -o NAME "$DEV" | wc -l | tr -d ' ')" = "1" ] || err "$DEV has partitions"
[ -z "$(wipefs -n "$DEV" 2>&1)" ] || err "a filesystem or partition signature was found on $DEV"
if blkid -p "$DEV" >/dev/null 2>&1; then err "a filesystem or partition signature was found on $DEV"; fi
command -v mkfs.ext4 >/dev/null 2>&1 || err "mkfs.ext4 is not installed on this server (install e2fsprogs)"
mkfs.ext4 -q -L ${shQuote(label)} -m 1 -E nodiscard "$DEV" </dev/null || err "mkfs.ext4 failed"
UUID=$(blkid -s UUID -o value "$DEV")
[ -n "$UUID" ] || err "the new filesystem has no UUID"
mkdir -p "$MNT"
sed -i "\\| $MNT |d" /etc/fstab
echo "UUID=$UUID $MNT ext4 defaults,nofail,x-systemd.device-timeout=10s 0 2" >> /etc/fstab
command -v systemctl >/dev/null 2>&1 && systemctl daemon-reload >/dev/null 2>&1 || true
mountpoint -q "$MNT" || mount "$MNT"
mkdir -p "$MNT/volumes"
echo "__SWARMY_FORMATTED__ $UUID"
`;
}

/** Host script that grows the filesystem of a swarmy disk to the size of its (enlarged) device. Online. */
export function renderGrowScript(serial: string): string {
  const mnt = diskMountpoint(serial);
  return `set -eu
err() { echo "__SWARMY_ERR__ $*"; exit 3; }
MNT=${shQuote(mnt)}
mountpoint -q "$MNT" || err "$MNT is not mounted"
SRC=$(findmnt -n -o SOURCE --mountpoint "$MNT")
FS=$(findmnt -n -o FSTYPE --mountpoint "$MNT")
case "$FS" in
  ext2|ext3|ext4) resize2fs "$SRC" >/dev/null 2>&1 || err "resize2fs failed" ;;
  xfs) xfs_growfs "$MNT" >/dev/null 2>&1 || err "xfs_growfs failed" ;;
  *) err "cannot grow a $FS filesystem" ;;
esac
echo "__SWARMY_GROWN__ $(df -Pk "$MNT" | awk 'NR==2 {print $2*1024}')"
`;
}

/** Host script that makes a placed volume's directory, refusing if its disk is not mounted (never fill the root disk). */
export function renderVolumeDirScript(device: string): string {
  const d = parseDiskVolumeDevice(device);
  if (!d) throw new Error('not a swarmy disk volume path');
  return `set -eu
mountpoint -q ${shQuote(d.mountpoint)} || { echo "__SWARMY_ERR__ ${d.mountpoint} is not mounted"; exit 3; }
mkdir -p ${shQuote(device)}
echo __SWARMY_OK__
`;
}
