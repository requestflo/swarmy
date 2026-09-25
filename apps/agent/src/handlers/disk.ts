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
  renderDiskProbeScript,
  renderFormatScript,
  renderGrowScript,
  renderVolumeDirScript,
} from '@swarmy/core';
import type { DockerClient } from '@swarmy/core/docker';
import type {
  FormatDiskPayload,
  FormatDiskResult,
  GrowDiskPayload,
  GrowDiskResult,
  ListDisksResult,
} from '@swarmy/core/protocol';
import { env } from '../env';
import { runOnHost } from './mesh-pin';

export type HostRunner = (script: string, timeoutMs?: number) => Promise<{ code: number; out: string }>;

export interface DiskDeps {
  runHost: HostRunner;
  override: 'allow' | 'deny' | undefined;
}

export function defaultDiskDeps(docker: DockerClient): DiskDeps {
  return { runHost: (s, t) => runOnHost(docker, s, t), override: env.DISK_FORMAT_OVERRIDE };
}

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
  return { disks: diskEntries(probe), ...(deps.override ? { localOverride: deps.override } : {}) };
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

/** Make the directory a disk-placed volume binds to; refuses when the disk is not mounted. */
export async function ensureDiskVolumeDir(runHost: HostRunner, device: string): Promise<void> {
  const r = await runHost(renderVolumeDirScript(device), 30_000);
  if (r.code !== 0 || !r.out.includes('__SWARMY_OK__')) {
    throw fail('E_DISK_NOT_MOUNTED', hostError(r.out, `could not prepare ${device}`));
  }
}
