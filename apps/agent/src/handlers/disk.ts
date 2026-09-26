/**
 * "Add a disk" on the host (plans/epic-volume-mobility.md, phase 1).
 *
 * Every step runs in the host's namespaces through `runOnHost` (native for the
 * binary agent, a one-shot `--pid host --privileged` nsenter container for the
 * container agent — the same privileged path the mesh pin uses). The logic is
 * in `@swarmy/core` (classifier, `formatGate`, the host scripts); this module
 * only sequences probe → gate → format.
 *
 * Formatting is refused unless (1) the node capability allows it
 * (`diskFormatGateAllows`), (2) `formatGate` passes on a FRESH probe taken
 * right now, and (3) the format script's own re-checks pass in the same shell
 * as `mkfs`. ext4 only. Never automatic: only an operator command gets here.
 */
import {
  diskEntries,
  diskFormatGateAllows,
  diskId,
  diskMountpoint,
  formatGate,
  parseDiskProbe,
  parsePending,
  parseRepaired,
  renderDiskProbeScript,
  renderFormatScript,
  renderGrowScript,
  renderPendingProbeScript,
  renderRepairScript,
  renderVolumeDirScript,
  repairStamp,
} from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import type {
  FormatDiskPayload,
  FormatDiskResult,
  GrowDiskPayload,
  GrowDiskResult,
  ListDisksResult,
  DiskEntryWire,
  RepairDiskPayload,
  RepairDiskResult,
} from '@swarmy/core/protocol';
import { env } from '../env';
import { runOnHost } from './mesh-pin';

export type HostRunner = (script: string, timeoutMs?: number) => Promise<{ code: number; out: string }>;

/** A container using a volume (or bind) on a swarmy disk's mountpoint. */
export interface DiskUser {
  container: string;
  /** Swarm service name, when the container is a task. */
  service?: string;
  running: boolean;
}

export interface DiskDeps {
  runHost: HostRunner;
  override: 'allow' | 'deny' | undefined;
  /** Containers using volumes under `mountpoint` (QA-075b). Absent ⇒ none known. */
  users?: (mountpoint: string) => Promise<DiskUser[]>;
  /** `SWARMY_ALLOW_DISK_REPAIR` (default true). */
  repairAllowed?: boolean;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export function defaultDiskDeps(docker: DockerClient): DiskDeps {
  return {
    runHost: (s, t) => runOnHost(docker, s, t),
    override: env.DISK_FORMAT_OVERRIDE,
    users: (m) => diskUsers(docker, m),
    repairAllowed: env.ALLOW_DISK_REPAIR,
  };
}

interface VolumeLike {
  Name: string;
  Options?: Record<string, string> | null;
}

const under = (p: string | undefined, mnt: string) => Boolean(p) && (p === mnt || p!.startsWith(`${mnt}/`));

/**
 * Every container (running or not) whose mounts are on `mnt`: a `local`
 * volume bound to a device under it (how swarmy places volumes on a disk),
 * or a bind mount from it.
 */
export async function diskUsers(docker: DockerClient, mnt: string): Promise<DiskUser[]> {
  const res = (await docker.docker.listVolumes()) as { Volumes?: VolumeLike[] | null };
  const onDisk = new Set((res.Volumes ?? []).filter((v) => under(v.Options?.device, mnt)).map((v) => v.Name));
  const containers = await docker.listContainers(true);
  return containers
    .filter((c) =>
      (c.mounts ?? []).some((m) => (m.type === 'volume' && m.source !== undefined && onDisk.has(m.source)) || (m.type === 'bind' && under(m.source, mnt))),
    )
    .map((c) => ({
      container: c.name,
      ...(c.labels?.['com.docker.swarm.service.name'] ? { service: c.labels['com.docker.swarm.service.name'] } : {}),
      running: c.state === 'running',
    }));
}

const userNames = (users: readonly DiskUser[]) => [...new Set(users.map((u) => u.service ?? u.container))].sort();

/** A coded error the executor's `run()` turns into `{ code, message }`. */
function fail(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function hostError(out: string, fallback: string): string {
  return /__SWARMY_ERR__ (.*)/.exec(out)?.[1]?.trim() || out.trim().slice(-300) || fallback;
}

export async function listDisks(deps: DiskDeps): Promise<ListDisksResult> {
  const r = await deps.runHost(renderDiskProbeScript(), 60_000);
  const probe = parseDiskProbe(r.out);
  if (probe.error || (r.code !== 0 && probe.devices.length === 0)) {
    throw fail('E_DISK_PROBE', hostError(r.out, 'could not list the disks on this server'));
  }
  const disks: DiskEntryWire[] = diskEntries(probe);
  await attachPending(deps, disks);
  return { disks, ...(deps.override ? { localOverride: deps.override } : {}) };
}

/**
 * QA-075b: for each swarmy disk that is not mounted, how much was written into
 * its bare mountpoint on the root disk and which apps use it. Best effort: a
 * failed probe leaves `pending` off, never fails the listing.
 */
async function attachPending(deps: DiskDeps, disks: DiskEntryWire[]): Promise<void> {
  const broken = disks.filter((d) => d.state === 'swarmy-unmounted' && d.serial);
  if (broken.length === 0) return;
  let pending: ReturnType<typeof parsePending> = {};
  try {
    pending = parsePending((await deps.runHost(renderPendingProbeScript(broken.map((d) => d.serial!)), 60_000)).out);
  } catch {
    // leave it unknown
  }
  for (const d of broken) {
    const mnt = diskMountpoint(d.serial!);
    const p = pending[mnt];
    const users = await (deps.users?.(mnt) ?? Promise.resolve([])).catch(() => [] as DiskUser[]);
    if (p || users.length > 0) {
      d.pending = { files: p?.files ?? 0, bytes: p?.bytes ?? 0, services: userNames(users), running: userNames(users.filter((u) => u.running)) };
    }
  }
}

export async function formatDisk(deps: DiskDeps, p: FormatDiskPayload): Promise<FormatDiskResult> {
  if (!diskFormatGateAllows(deps.override, p.nodeCapable)) {
    throw fail(
      'E_DISK_FORMAT_DISABLED',
      deps.override === 'deny'
        ? 'formatting disks is turned off on this server (SWARMY_ALLOW_DISK_FORMAT=false in /etc/swarmy/agent.env)'
        : 'formatting disks is turned off for this server (swarmy.node.diskFormat=false)',
    );
  }
  const r = await deps.runHost(renderDiskProbeScript(p.path), 60_000);
  const probe = parseDiskProbe(r.out);
  if (probe.error) throw fail('E_DISK_PROBE', probe.error);
  const gate = formatGate({
    devices: probe.devices,
    expected: { path: p.path, serial: p.serial, sizeBytes: p.sizeBytes },
    // No signature section at all (older host tools, odd output) ⇒ refuse.
    wipefsOutput: probe.signatures ?? 'the signature probe did not run',
    typedConfirmation: p.typedConfirmation,
  });
  if (!gate.ok) throw fail('E_DISK_REFUSED', gate.reason);

  const f = await deps.runHost(renderFormatScript({ path: p.path, serial: p.serial, sizeBytes: p.sizeBytes }), 900_000);
  const uuid = /__SWARMY_FORMATTED__ (\S+)/.exec(f.out)?.[1];
  if (f.code !== 0 || !uuid) throw fail('E_DISK_FORMAT', hostError(f.out, 'formatting failed'));
  return { serial: p.serial, id: diskId(p.serial), mountpoint: diskMountpoint(p.serial), uuid, sizeBytes: p.sizeBytes };
}

export async function growDisk(deps: DiskDeps, p: GrowDiskPayload): Promise<GrowDiskResult> {
  const mountpoint = diskMountpoint(p.serial);
  const listed = await listDisks(deps);
  const disk = listed.disks.find((d) => d.serial === p.serial.trim() && d.state === 'swarmy');
  if (!disk) throw fail('E_DISK_REFUSED', `no swarmy disk with serial ${p.serial} on this server`);
  if (disk.growableBytes <= 0) throw fail('E_DISK_REFUSED', 'the filesystem already fills the disk — grow the volume in your cloud console first');
  const r = await deps.runHost(renderGrowScript(p.serial), 900_000);
  const size = Number(/__SWARMY_GROWN__ (\d+)/.exec(r.out)?.[1]);
  if (r.code !== 0 || !Number.isFinite(size)) throw fail('E_DISK_GROW', hostError(r.out, 'growing the filesystem failed'));
  return { serial: p.serial, mountpoint, fsTotalBytes: size };
}

const POLL_MS = 2_000;

/**
 * Re-attach a swarmy disk that is formatted but not mounted on the host
 * (QA-075b). Refuses unless a FRESH probe shows exactly that disk as
 * `swarmy-unmounted`; waits until no running container uses the disk (the
 * controller scales its services to 0 first), else `E_DISK_BUSY`; then runs
 * the repair script (copy → verify → keep originals aside → mount → host
 * check → fstab). Already mounted ⇒ a no-op success.
 */
export async function repairDisk(deps: DiskDeps, p: RepairDiskPayload): Promise<RepairDiskResult> {
  if (deps.repairAllowed === false) {
    throw fail('E_DISK_REPAIR_DISABLED', 're-attaching disks is turned off on this server (SWARMY_ALLOW_DISK_REPAIR=false in /etc/swarmy/agent.env)');
  }
  if (p.nodeCapable === false) throw fail('E_DISK_REPAIR_DISABLED', 're-attaching disks is turned off for this server (swarmy.node.diskRepair=false)');
  const serial = p.serial.trim();
  const base = { serial, id: diskId(serial), mountpoint: diskMountpoint(serial) };
  const r = await deps.runHost(renderDiskProbeScript(), 60_000);
  const probe = parseDiskProbe(r.out);
  if (probe.error) throw fail('E_DISK_PROBE', probe.error);
  const disk = diskEntries(probe).find((d) => d.serial === serial);
  if (!disk) throw fail('E_DISK_REFUSED', `no disk with serial ${serial} on this server`);
  if (disk.state === 'swarmy' && disk.mountpoints.includes(base.mountpoint)) {
    return { ...base, alreadyMounted: true, uuid: null, moved: false, files: 0, bytes: 0, aside: null };
  }
  if (disk.state !== 'swarmy-unmounted') throw fail('E_DISK_REFUSED', `${disk.path} is not a swarmy disk waiting to be attached: ${disk.reason}`);
  if (disk.path !== p.path) throw fail('E_DISK_REFUSED', `the disk moved from ${p.path} to ${disk.path} — list the disks again`);

  // Nothing may be writing to the bare directory while it is copied.
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((res) => setTimeout(res, ms)));
  const now = deps.now ?? Date.now;
  const deadline = now() + p.waitMs;
  for (;;) {
    const running = ((await deps.users?.(base.mountpoint)) ?? []).filter((u) => u.running);
    if (running.length === 0) break;
    if (now() >= deadline) {
      throw fail('E_DISK_BUSY', `still in use by ${userNames(running).join(', ')} — stop them first, then try again`);
    }
    await sleep(POLL_MS);
  }

  const out = await deps.runHost(renderRepairScript({ path: disk.path, serial, stamp: p.stamp }), p.timeoutMs ?? 4 * 3_600_000);
  const done = parseRepaired(out.out);
  if (out.code !== 0 || !done) throw fail('E_DISK_REPAIR', hostError(out.out, 're-attaching the disk failed'));
  return { ...base, alreadyMounted: false, ...done };
}

/**
 * Agent start (QA-085): a swarmy disk that came back after a reboot but was
 * not mounted (the cloud attached it after fstab's device timeout) is mounted
 * straight away — but ONLY when its mountpoint is empty or missing, nothing
 * running uses it, and this box's fstab already declares it by UUID. Nothing
 * is copied or moved here; everything else waits for the controller's
 * disk-reconcile. Never throws; returns the serials it mounted.
 */
export async function mountReturningDisks(deps: DiskDeps, log: (m: string) => void): Promise<string[]> {
  if (deps.repairAllowed === false) return [];
  let listed: ListDisksResult;
  try {
    listed = await listDisks(deps);
  } catch {
    return [];
  }
  const mounted: string[] = [];
  for (const d of listed.disks) {
    if (d.state !== 'swarmy-unmounted' || !d.serial) continue;
    if ((d.pending?.files ?? 0) > 0 || (d.pending?.running?.length ?? 0) > 0) continue;
    const r = await deps.runHost(renderRepairScript({ path: d.path, serial: d.serial, stamp: repairStamp(), onlyIfEmptyAndInFstab: true }), 120_000);
    if (r.code === 0 && parseRepaired(r.out)) {
      mounted.push(d.serial);
      log(`disk ${d.name} (${d.serial}) was back but not mounted; mounted it at ${diskMountpoint(d.serial)}`);
    } else {
      log(`disk ${d.name} (${d.serial}) is not mounted; left for the controller: ${hostError(r.out, 'mount failed')}`);
    }
  }
  return mounted;
}

/** Make the directory a disk-placed volume binds to; refuses when the disk is not mounted. */
export async function ensureDiskVolumeDir(runHost: HostRunner, device: string): Promise<void> {
  const r = await runHost(renderVolumeDirScript(device), 30_000);
  if (r.code !== 0 || !r.out.includes('__SWARMY_OK__')) {
    throw fail('E_DISK_NOT_MOUNTED', hostError(r.out, `could not prepare ${device}`));
  }
}
