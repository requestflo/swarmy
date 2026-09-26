/**
 * "Add a disk" (plans/epic-volume-mobility.md, phase 1), controller side.
 *
 * - {@link listNodeDisks}    — what block devices a server has, classified, and
 *                              whether swarmy may format there.
 * - {@link formatNodeDisk}   — format + mount a BLANK disk (ext4), then declare it
 *                              on the node: `swarmy.disk.<id>=<mount>` and, for the
 *                              first one, `swarmy.disk.default=<id>`. Audited.
 * - {@link growNodeDisk}     — grow a swarmy disk's filesystem after the owner
 *                              enlarged the cloud volume. One click; cannot lose data.
 * - {@link setDiskFormatAllowed} — the per-node opt-out (`swarmy.node.diskFormat`).
 * - {@link placeOnDefaultDisk} — pre-create a NEW named volume on the node's
 *                              default disk, so new data lands there.
 * - {@link repairNodeDisk}   — re-attach a swarmy disk that is formatted but not
 *                              mounted on the host (QA-075b): stop the apps on it,
 *                              move what was written to the root disk onto it,
 *                              mount it, start the apps again. Audited.
 * - {@link runDiskReconcileFor} — the disk-reconcile worker's per-node check.
 *
 * Docker is the source of truth (node labels); no table.
 */
import {
  defaultDiskMount,
  DISK_DEFAULT_LABEL,
  explainPinNode,
  diskId,
  diskLabelsAfterFormat,
  diskVolumeOptions,
  isDiskFormatCapable,
  isDiskRepairCapable,
  nodeDisks,
  NODE_DISK_FORMAT_LABEL,
  repairStamp,
} from '@swarmy/core';
import type {
  DiskEntryWire,
  FormatDiskResult,
  GrowDiskResult,
  ListDisksResult,
  RepairDiskResult,
  SwarmServiceInfo,
} from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import type { AgentHub } from '../hub/types';
import { commandRejected, mapDispatchError, noManager, nodeOffline, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dispatchNodeLabels } from './node.service';

type Ctx = Pick<OrgContext, 'db' | 'hub' | 'activeOrgId' | 'user'>;

export interface DiskWarning {
  diskId: string;
  /** Device name (`sdb`) when the disk is connected. */
  name: string | null;
  /** `unmounted`: formatted by swarmy but not attached; `missing`: not connected to the server at all. */
  kind: 'unmounted' | 'missing';
  isDefault: boolean;
  message: string;
}

export interface LastDiskRepair {
  at: string;
  files: number;
  bytes: number;
  /** Where the originals were kept on the root disk. */
  aside: string | null;
}

export interface NodeDisksView {
  nodeId: string;
  /** May swarmy format a blank disk on this server (label + local override)? */
  formatAllowed: boolean;
  /** Why not, in plain words, when it may not. */
  formatBlockedReason: string | null;
  disks: (DiskEntryWire & { isDefault: boolean })[];
  /** Disks the server's labels declare that are not really mounted (QA-075b). */
  warnings: DiskWarning[];
  /** The newest re-attach that moved files off the root disk, when there was one. */
  lastRepair: LastDiskRepair | null;
}

async function ownNode(ctx: Ctx, nodeId: string): Promise<void> {
  const row = await ctx.db.node.findFirst({ where: { id: nodeId, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!row) throw notFound('node', nodeId);
  if (!ctx.hub.isOnline(nodeId)) throw nodeOffline(nodeId);
}

function labelsOf(ctx: Ctx, nodeId: string): Record<string, string> {
  return ctx.hub.nodeInfoFor(nodeId)?.labels ?? {};
}

/** `4.2 GB` / `310 MB` — for the plain-words messages. */
export function sizeWords(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 0 : 1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

/** Pure: the list view from the agent's answer and the node's labels. */
export function disksView(
  nodeId: string,
  labels: Record<string, string>,
  listed: ListDisksResult,
  lastRepair: LastDiskRepair | null = null,
): NodeDisksView {
  const formatAllowed = isDiskFormatCapable(labels, listed.localOverride);
  const declared = nodeDisks(labels);
  const warnings: DiskWarning[] = [];
  for (const decl of declared) {
    const d = listed.disks.find((x) => x.id === decl.id);
    if (d?.state === 'swarmy') continue;
    const where = decl.isDefault ? ' New databases go to another server until it is.' : '';
    if (!d) {
      warnings.push({
        diskId: decl.id, name: null, kind: 'missing', isDefault: decl.isDefault,
        message: `The data disk …${decl.id.slice(-4)} is not connected to this server, so nothing can be stored on it.${where}`,
      });
    } else {
      const moved = d.pending && d.pending.bytes > 0 ? ` and moves the ${sizeWords(d.pending.bytes)} written in the meantime` : '';
      warnings.push({
        diskId: decl.id, name: d.name, kind: 'unmounted', isDefault: decl.isDefault,
        message: `${d.name} is set up for app data but not attached, so new data is not reaching it. swarmy attaches it${moved}.${where}`,
      });
    }
  }
  return {
    nodeId,
    formatAllowed,
    formatBlockedReason: formatAllowed
      ? null
      : listed.localOverride === 'deny'
        ? 'Formatting is turned off on this server (SWARMY_ALLOW_DISK_FORMAT=false).'
        : 'Formatting is turned off for this server.',
    // Only a disk that is REALLY mounted takes new data (QA-075b).
    disks: listed.disks.map((d) => ({ ...d, isDefault: d.state === 'swarmy' && declared.some((x) => x.id === d.id && x.isDefault) })),
    warnings,
    lastRepair,
  };
}

// ── What each server's disks looked like last time we asked (process memory) ──

const LISTING_TTL_MS = 15 * 60_000;
const listings = new Map<string, { at: number; disks: DiskEntryWire[] }>();

/** Remember a node's disk listing (placement reads it; a restart forgets — the worker re-lists on connect). */
export function recordDiskListing(nodeId: string, disks: DiskEntryWire[], at = Date.now()): void {
  listings.set(nodeId, { at, disks });
}

/** Test seam. */
export function resetDiskListings(): void {
  listings.clear();
}

/**
 * Swarm node ids whose DECLARED default disk the last listing showed as not
 * mounted (or not connected). Unknown (never listed, or stale) ⇒ not included:
 * `placeOnDefaultDisk({required})` still refuses on the agent's own check.
 */
export function unmountedDefaultDiskNodes(hub: Pick<AgentHub, 'nodeInventory' | 'onlineNodeIds' | 'swarmNodeIdFor'>, orgId: string, now = Date.now()): Set<string> {
  const out = new Set<string>();
  const online = hub.onlineNodeIds();
  for (const n of hub.nodeInventory(orgId)) {
    const def = n.labels?.[DISK_DEFAULT_LABEL];
    if (!def || !defaultDiskMount(n.labels)) continue;
    const nodeId = online.find((id) => hub.swarmNodeIdFor(id) === n.swarmNodeId);
    const seen = nodeId ? listings.get(nodeId) : undefined;
    if (!seen || now - seen.at > LISTING_TTL_MS) continue;
    if (seen.disks.find((d) => d.id === def)?.state !== 'swarmy') out.add(n.swarmNodeId);
  }
  return out;
}

/**
 * Pick the node a NEW data member is pinned to (`explainPinNode`), skipping a
 * node whose declared default disk is not really mounted (QA-075b). Throws a
 * plain-words refusal only when no node is eligible; a skip is audited as
 * `data.placement.skip` with the reason.
 */
export function chooseDiskAwarePin(
  ctx: Pick<OrgContext, 'hub' | 'activeOrgId'> & Partial<Pick<OrgContext, 'db' | 'user'>>,
  pinnedCounts: ReadonlyMap<string, number>,
  fallback: string | undefined,
): string | undefined {
  const r = explainPinNode({
    nodes: ctx.hub.nodeInventory(ctx.activeOrgId),
    pinnedCounts,
    ...(fallback ? { fallback } : {}),
    unmountedDefaultDisk: unmountedDefaultDiskNodes(ctx.hub, ctx.activeOrgId),
  });
  if (r.refusal) throw commandRejected(r.refusal);
  if (r.note) {
    console.warn(`[placement] ${r.note}`);
    if (ctx.db) void writeAudit({ db: ctx.db, activeOrgId: ctx.activeOrgId, user: ctx.user }, { action: 'data.placement.skip', metadata: { note: r.note, node: r.node } });
  }
  return r.node;
}

const REPAIR_DONE = 'node.disk.repair.done';

async function lastMovingRepair(ctx: Ctx, nodeId: string): Promise<LastDiskRepair | null> {
  try {
    const row = await ctx.db.auditLog.findFirst({
      where: { orgId: ctx.activeOrgId, targetType: 'node', targetId: nodeId, action: REPAIR_DONE },
      orderBy: { ts: 'desc' },
      select: { ts: true, metadata: true },
    });
    const m = (row?.metadata ?? {}) as Partial<RepairDiskResult>;
    if (!row || !m.moved) return null;
    return { at: new Date(row.ts).toISOString(), files: Number(m.files ?? 0), bytes: Number(m.bytes ?? 0), aside: m.aside ?? null };
  } catch {
    return null;
  }
}

export async function listNodeDisks(ctx: Ctx, nodeId: string): Promise<NodeDisksView> {
  await ownNode(ctx, nodeId);
  let listed: ListDisksResult;
  try {
    listed = await ctx.hub.dispatch<ListDisksResult>(nodeId, 'disk.list', {});
  } catch (e) {
    throw mapDispatchError(e);
  }
  recordDiskListing(nodeId, listed.disks);
  return disksView(nodeId, labelsOf(ctx, nodeId), listed, await lastMovingRepair(ctx, nodeId));
}

export async function formatNodeDisk(
  ctx: Ctx,
  input: { nodeId: string; path: string; serial: string; sizeBytes: number; confirm: string },
): Promise<FormatDiskResult & { isDefault: boolean }> {
  await ownNode(ctx, input.nodeId);
  const labels = labelsOf(ctx, input.nodeId);
  // The agent re-checks with its local override; this is the label read it trusts.
  const nodeCapable = isDiskFormatCapable(labels, undefined);
  if (!nodeCapable) throw commandRejected('formatting disks is turned off for this server');
  const target = { targetType: 'node', targetId: input.nodeId } as const;
  let result: FormatDiskResult;
  try {
    result = await ctx.hub.dispatch<FormatDiskResult>(input.nodeId, 'disk.format', {
      path: input.path,
      serial: input.serial,
      sizeBytes: input.sizeBytes,
      typedConfirmation: input.confirm,
      fstype: 'ext4',
      nodeCapable,
    });
  } catch (e) {
    await writeAudit(ctx, {
      action: 'node.disk.format',
      ...target,
      metadata: { path: input.path, serial: input.serial, outcome: 'refused', error: e instanceof Error ? e.message : String(e) },
    });
    throw mapDispatchError(e);
  }
  const patch = diskLabelsAfterFormat(result.serial, labels);
  const labelled = await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, input.nodeId, patch);
  await writeAudit(ctx, {
    action: 'node.disk.format',
    ...target,
    metadata: { path: input.path, serial: result.serial, uuid: result.uuid, mountpoint: result.mountpoint, sizeBytes: result.sizeBytes, fstype: 'ext4', labelled, outcome: 'formatted' },
  });
  return { ...result, isDefault: 'swarmy.disk.default' in patch };
}

export async function growNodeDisk(ctx: Ctx, input: { nodeId: string; serial: string }): Promise<GrowDiskResult> {
  await ownNode(ctx, input.nodeId);
  try {
    const r = await ctx.hub.dispatch<GrowDiskResult>(input.nodeId, 'disk.grow', { serial: input.serial });
    await writeAudit(ctx, { action: 'node.disk.grow', targetType: 'node', targetId: input.nodeId, metadata: { ...r } });
    return r;
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/** Per-node opt-out: `swarmy.node.diskFormat=false` (off) / `true` (on, the default). Admin, audited. */
export async function setDiskFormatAllowed(ctx: Ctx, input: { nodeId: string; allowed: boolean }): Promise<{ nodeId: string; allowed: boolean }> {
  const row = await ctx.db.node.findFirst({ where: { id: input.nodeId, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!row) throw notFound('node', input.nodeId);
  const ok = await dispatchNodeLabels(ctx.hub, ctx.activeOrgId, input.nodeId, { [NODE_DISK_FORMAT_LABEL]: String(input.allowed) });
  if (!ok) throw commandRejected('could not update the server (no manager online)');
  await writeAudit(ctx, { action: 'node.disk.formatAllowed', targetType: 'node', targetId: input.nodeId, metadata: { allowed: input.allowed } });
  return input;
}

/**
 * Put a NEW named volume on the default disk of the swarm node that will run
 * it: `volume.provision` on that node with a `local` bind device under the
 * disk (the agent makes the directory and refuses if the disk is not
 * mounted). Docker then reuses the existing volume when the task starts, so
 * the service spec is unchanged. Returns the device, or null when the node
 * has no default disk / is not connected / the pre-create failed (the volume
 * is then created on the root disk as before — never an error for the caller).
 *
 * `required`: when the node DOES declare a default disk, a failed pre-create
 * throws instead of silently falling back to the root disk (QA-076) — the
 * managed Postgres path, where data on the wrong disk is the bug.
 */
export async function placeOnDefaultDisk(
  ctx: Pick<OrgContext, 'hub'>,
  swarmNodeId: string | undefined,
  volumeName: string,
  opts: { required?: boolean } = {},
): Promise<string | null> {
  if (!swarmNodeId) return null;
  let options: ReturnType<typeof diskVolumeOptions> = null;
  try {
    const nodeId = ctx.hub.onlineNodeIds().find((id) => ctx.hub.swarmNodeIdFor(id) === swarmNodeId);
    if (!nodeId) return null;
    options = diskVolumeOptions(ctx.hub.nodeInfoFor(nodeId)?.labels, volumeName);
    if (!options) return null;
    await ctx.hub.dispatch(nodeId, 'volume.provision', { spec: { name: volumeName, mode: 'local', options } });
    return options.device;
  } catch (e) {
    if (opts.required && options) {
      const why = e instanceof Error ? e.message : String(e);
      throw commandRejected(`could not put ${volumeName} on the server's default disk (${why}) — refusing to fall back to the root disk`);
    }
    return null;
  }
}

// ── Re-attach a disk that is formatted but not mounted (QA-075b) ─────────────

/** Pure: which of the disk's users swarmy can stop (replicated services) and which block it (global ones). */
export function planRepairScale(
  names: readonly string[],
  services: readonly Pick<SwarmServiceInfo, 'name' | 'mode' | 'desiredReplicas'>[],
): { scale: { service: string; replicas: number }[]; global: string[]; unknown: string[] } {
  const scale: { service: string; replicas: number }[] = [];
  const global: string[] = [];
  const unknown: string[] = [];
  for (const name of names) {
    const svc = services.find((s) => s.name === name);
    if (!svc) unknown.push(name);
    else if (svc.mode === 'global') global.push(name);
    else if ((svc.desiredReplicas ?? 0) > 0) scale.push({ service: name, replicas: svc.desiredReplicas! });
  }
  return { scale, global, unknown };
}

export interface RepairNodeDiskResult extends RepairDiskResult {
  /** Services stopped for the move and started again. */
  services: string[];
  /** Services that did not come back (the error), when any. */
  restartErrors: string[];
}

const HOUR_MS = 3_600_000;

/**
 * Re-attach a swarmy disk that the node's labels declare but the host has not
 * mounted (QA-075b). Scales the replicated services using it to 0 (aborts on
 * a global service — it cannot be stopped on one server), dispatches
 * `disk.repair` (the agent waits for the containers to stop, copies what was
 * written to the root disk onto the disk, verifies, keeps the originals and
 * mounts it), then ALWAYS scales the services back, even on failure.
 * Audited: `node.disk.repair.{start,stopped,done,failed,restarted}`.
 */
export async function repairNodeDisk(
  ctx: Ctx,
  input: { nodeId: string; serial: string },
  opts: { system?: boolean; listed?: ListDisksResult } = {},
): Promise<RepairNodeDiskResult> {
  await ownNode(ctx, input.nodeId);
  const serial = input.serial.trim();
  const labels = labelsOf(ctx, input.nodeId);
  if (!isDiskRepairCapable(labels)) throw commandRejected('re-attaching disks is turned off for this server (swarmy.node.diskRepair=false)');
  let id: string;
  try {
    id = diskId(serial);
  } catch {
    throw commandRejected('that disk has no usable serial');
  }
  if (!nodeDisks(labels).some((d) => d.id === id)) throw commandRejected(`disk …${id.slice(-4)} is not one swarmy set up on this server`);

  let listed = opts.listed;
  if (!listed) {
    try {
      listed = await ctx.hub.dispatch<ListDisksResult>(input.nodeId, 'disk.list', {});
    } catch (e) {
      throw mapDispatchError(e);
    }
  }
  recordDiskListing(input.nodeId, listed.disks);
  const disk = listed.disks.find((d) => d.serial === serial);
  if (!disk) throw commandRejected(`disk …${id.slice(-4)} is not connected to this server`);
  const base = { serial, id, mountpoint: disk.mountpoints[0] ?? `/var/lib/swarmy/disks/${id}` };
  if (disk.state === 'swarmy') {
    return { ...base, alreadyMounted: true, uuid: null, moved: false, files: 0, bytes: 0, aside: null, services: [], restartErrors: [] };
  }
  if (disk.state !== 'swarmy-unmounted') throw commandRejected(disk.reason);

  const target = { targetType: 'node', targetId: input.nodeId, ...(opts.system ? { actorType: 'system' as const } : {}) };
  const audit = (step: 'start' | 'stopped' | 'done' | 'failed' | 'restarted', metadata: Record<string, unknown>) =>
    writeAudit(ctx, { action: `node.disk.repair.${step}`, ...target, metadata: { serial, id, ...metadata } });

  const users = disk.pending?.services ?? [];
  const plan = planRepairScale(users, ctx.hub.liveInventory(ctx.activeOrgId).services);
  if (plan.global.length > 0) {
    const error = `${plan.global.join(', ')} runs on every server, so swarmy cannot stop it here to move its data — stop it by hand, then try again`;
    await audit('failed', { error, services: users });
    throw commandRejected(error);
  }
  await audit('start', { services: users, files: disk.pending?.files ?? 0, bytes: disk.pending?.bytes ?? 0 });

  const manager = plan.scale.length > 0 ? ctx.hub.managerNode(ctx.activeOrgId) : undefined;
  if (plan.scale.length > 0 && !manager) {
    await audit('failed', { error: 'no online manager to stop the apps with' });
    throw noManager();
  }

  const stopped: { service: string; replicas: number }[] = [];
  const restartErrors: string[] = [];
  let result: RepairDiskResult | undefined;
  let failure: unknown;
  try {
    for (const s of plan.scale) {
      // Recorded BEFORE the dispatch: a half-applied scale is still scaled back.
      stopped.push(s);
      await ctx.hub.dispatch(manager!, 'service.scale', { service: s.service, replicas: 0 });
    }
    if (stopped.length > 0) await audit('stopped', { services: stopped });
    result = await ctx.hub.dispatch<RepairDiskResult>(
      input.nodeId,
      'disk.repair',
      { path: disk.path, serial, stamp: repairStamp(), waitMs: 120_000, nodeCapable: true },
      { timeoutMs: 4 * HOUR_MS },
    );
    await audit('done', { ...result });
    recordDiskListing(
      input.nodeId,
      listed.disks.map((d) => (d.serial === serial ? { ...d, state: 'swarmy' as const, mountpoints: [result!.mountpoint], pending: undefined } : d)),
    );
  } catch (e) {
    failure = e;
    await audit('failed', { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) });
  } finally {
    for (const s of stopped) {
      try {
        await ctx.hub.dispatch(manager!, 'service.scale', { service: s.service, replicas: s.replicas });
      } catch (e) {
        restartErrors.push(`${s.service}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (stopped.length > 0) await audit('restarted', { services: stopped, errors: restartErrors });
  }
  if (failure !== undefined || !result) throw mapDispatchError(failure);
  return { ...result, services: stopped.map((s) => s.service), restartErrors };
}

export type DiskReconcileOutcome =
  | { nodeId: string; skipped: 'offline' | 'no-disks' | 'disabled' }
  | { nodeId: string; checked: number; repaired: string[]; failed: { serial: string; error: string }[] };

/**
 * The disk-reconcile worker's check of ONE node (system actor): list its
 * disks and re-attach each disk the node's `swarmy.disk.<id>` labels declare
 * that is formatted but not mounted. Never touches an undeclared disk.
 * `skip(serial)` lets the worker back off a disk that failed recently.
 */
export async function runDiskReconcileFor(
  ctx: OrgContext,
  nodeId: string,
  skip: (serial: string) => boolean = () => false,
): Promise<DiskReconcileOutcome> {
  if (!ctx.hub.isOnline(nodeId)) return { nodeId, skipped: 'offline' };
  const labels = labelsOf(ctx, nodeId);
  const declared = nodeDisks(labels);
  if (declared.length === 0) return { nodeId, skipped: 'no-disks' };
  if (!isDiskRepairCapable(labels)) return { nodeId, skipped: 'disabled' };
  const listed = await ctx.hub.dispatch<ListDisksResult>(nodeId, 'disk.list', {});
  recordDiskListing(nodeId, listed.disks);
  const repaired: string[] = [];
  const failed: { serial: string; error: string }[] = [];
  for (const d of listed.disks) {
    if (d.state !== 'swarmy-unmounted' || !d.serial || !declared.some((x) => x.id === d.id) || skip(d.serial)) continue;
    try {
      await repairNodeDisk(ctx, { nodeId, serial: d.serial }, { system: true, listed });
      repaired.push(d.serial);
    } catch (e) {
      failed.push({ serial: d.serial, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { nodeId, checked: declared.length, repaired, failed };
}
