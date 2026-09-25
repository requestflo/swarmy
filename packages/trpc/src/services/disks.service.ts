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
 *
 * Docker is the source of truth (node labels); no table.
 */
import {
  diskLabelsAfterFormat,
  diskVolumeOptions,
  isDiskFormatCapable,
  nodeDisks,
  NODE_DISK_FORMAT_LABEL,
} from '@swarmy/core';
import type { FormatDiskResult, GrowDiskResult, ListDisksResult, DiskEntryWire } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, nodeOffline, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { dispatchNodeLabels } from './node.service';

type Ctx = Pick<OrgContext, 'db' | 'hub' | 'activeOrgId' | 'user'>;

export interface NodeDisksView {
  nodeId: string;
  /** May swarmy format a blank disk on this server (label + local override)? */
  formatAllowed: boolean;
  /** Why not, in plain words, when it may not. */
  formatBlockedReason: string | null;
  disks: (DiskEntryWire & { isDefault: boolean })[];
}

async function ownNode(ctx: Ctx, nodeId: string): Promise<void> {
  const row = await ctx.db.node.findFirst({ where: { id: nodeId, orgId: ctx.activeOrgId }, select: { id: true } });
  if (!row) throw notFound('node', nodeId);
  if (!ctx.hub.isOnline(nodeId)) throw nodeOffline(nodeId);
}

function labelsOf(ctx: Ctx, nodeId: string): Record<string, string> {
  return ctx.hub.nodeInfoFor(nodeId)?.labels ?? {};
}

/** Pure: the list view from the agent's answer and the node's labels. */
export function disksView(nodeId: string, labels: Record<string, string>, listed: ListDisksResult): NodeDisksView {
  const formatAllowed = isDiskFormatCapable(labels, listed.localOverride);
  const declared = nodeDisks(labels);
  return {
    nodeId,
    formatAllowed,
    formatBlockedReason: formatAllowed
      ? null
      : listed.localOverride === 'deny'
        ? 'Formatting is turned off on this server (SWARMY_ALLOW_DISK_FORMAT=false).'
        : 'Formatting is turned off for this server.',
    disks: listed.disks.map((d) => ({ ...d, isDefault: declared.some((x) => x.id === d.id && x.isDefault) })),
  };
}

export async function listNodeDisks(ctx: Ctx, nodeId: string): Promise<NodeDisksView> {
  await ownNode(ctx, nodeId);
  try {
    const listed = await ctx.hub.dispatch<ListDisksResult>(nodeId, 'disk.list', {});
    return disksView(nodeId, labelsOf(ctx, nodeId), listed);
  } catch (e) {
    throw mapDispatchError(e);
  }
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
 */
export async function placeOnDefaultDisk(
  ctx: Pick<OrgContext, 'hub'>,
  swarmNodeId: string | undefined,
  volumeName: string,
): Promise<string | null> {
  if (!swarmNodeId) return null;
  try {
    const nodeId = ctx.hub.onlineNodeIds().find((id) => ctx.hub.swarmNodeIdFor(id) === swarmNodeId);
    if (!nodeId) return null;
    const options = diskVolumeOptions(ctx.hub.nodeInfoFor(nodeId)?.labels, volumeName);
    if (!options) return null;
    await ctx.hub.dispatch(nodeId, 'volume.provision', { spec: { name: volumeName, mode: 'local', options } });
    return options.device;
  } catch {
    return null;
  }
}
