/**
 * The mesh control-plane lease object on this manager's own Docker socket:
 * the `swarmy.mesh.control.lease` label of the `swarmy-mesh-control-lease`
 * config (see @swarmy/core/protocol mesh-control-lease.ts for the rules).
 *
 * Every write is the controller store's: `decideLeaseWrite` against the label
 * just inspected, then `POST /configs/{id}/update?version=<index>` (Docker
 * lets a config's labels, and only them, change). A stale index fails with
 * "update out of sequence", so two writers can't both win; the first create
 * races on the name instead ("already exists"). The loser reports what is
 * live now, exactly like `controllerService` (casLossReason).
 */
import {
  MESH_CONTROL_LEASE_CONFIG,
  MESH_CONTROL_LEASE_LABEL,
  casLossReason,
  decideLeaseWrite,
  parseLeaseLabel,
  type ControllerLeaseRecord,
  type ControllerServiceOp,
  type ControllerServiceResult,
} from '@swarmy/core/protocol';
import { isOutOfSequence } from './controller-service';

export interface RawConfig {
  ID: string;
  Version: { Index: number };
  Spec: { Name: string; Labels?: Record<string, string>; Data?: string; [k: string]: unknown };
}

/** The slice of dockerode the lease needs (the agent passes `docker.docker`; tests a fake). */
export interface LeaseApi {
  info(): Promise<{ Name?: string; Swarm?: { NodeID?: string; LocalNodeState?: string; ControlAvailable?: boolean; Managers?: number } }>;
  listConfigs(opts: { filters: { name: string[] } }): Promise<Array<Pick<RawConfig, 'ID' | 'Spec'>>>;
  getConfig(id: string): { inspect(): Promise<RawConfig>; update(opts: Record<string, unknown>): Promise<unknown> };
  createConfig(spec: { Name: string; Data: string; Labels: Record<string, string> }): Promise<unknown>;
}

export interface LeaseSelf {
  /** The swarm node id: the holder, so an agent restart on this node keeps the lease. */
  holder: string;
  hostname?: string;
  /** Managers in the swarm (null when raft can't say). */
  managers: number | null;
}

/** Who we are in raft, or why this node can't hold the lease (a string). Throws when Docker can't answer. */
export async function leaseIdentity(api: LeaseApi): Promise<LeaseSelf | string> {
  const info = await api.info();
  const sw = info.Swarm ?? {};
  if (sw.LocalNodeState !== 'active' || !sw.NodeID) return 'this node is not in a swarm';
  if (!sw.ControlAvailable) return 'this node is not a swarm manager (the lease lives in raft)';
  return { holder: sw.NodeID, ...(info.Name ? { hostname: info.Name } : {}), managers: sw.Managers && sw.Managers > 0 ? sw.Managers : null };
}

export type LeaseOp = Extract<ControllerServiceOp, { kind: 'lease.acquire' | 'lease.renew' | 'lease.release' }>;

/** The config's payload never changes (only labels may): a note for whoever finds it. */
const NOTE = Buffer.from('swarmy: the mesh control-plane lease lives in this config\'s "swarmy.mesh.control.lease" label.\n').toString('base64');
const BASE_LABELS = { 'swarmy.system': 'true', 'swarmy.managed': 'true', 'swarmy.role': 'mesh-control-lease' };

export interface LeaseObject {
  id: string;
  version: number;
  spec: RawConfig['Spec'];
  record: ControllerLeaseRecord | null;
}

/** The lease object, or null when it doesn't exist yet (= no lease). Throws when Docker can't answer. */
export async function readMeshLease(api: LeaseApi): Promise<LeaseObject | null> {
  // The name filter matches prefixes: take the exact one.
  const hit = (await api.listConfigs({ filters: { name: [MESH_CONTROL_LEASE_CONFIG] } })).find((c) => c.Spec?.Name === MESH_CONTROL_LEASE_CONFIG);
  if (!hit) return null;
  const raw = await api.getConfig(hit.ID).inspect();
  return { id: hit.ID, version: raw.Version.Index, spec: raw.Spec, record: parseLeaseLabel(raw.Spec.Labels?.[MESH_CONTROL_LEASE_LABEL]) };
}

function isAlreadyExists(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /already exists|AlreadyExists|name conflicts|\b409\b/i.test(msg) || (e as { statusCode?: number })?.statusCode === 409;
}

/** Apply one lease op as a compare-and-swap. Throws only when Docker can't answer (no leader, not a manager). */
export async function writeMeshLease(api: LeaseApi, op: LeaseOp, now: () => number = Date.now): Promise<ControllerServiceResult> {
  const cur = await readMeshLease(api);
  const { next, result } = decideLeaseWrite(cur?.record ?? null, op, now());
  if (!next) return result;
  const value = JSON.stringify(next);
  try {
    if (!cur) await api.createConfig({ Name: MESH_CONTROL_LEASE_CONFIG, Data: NOTE, Labels: { ...BASE_LABELS, [MESH_CONTROL_LEASE_LABEL]: value } });
    else await api.getConfig(cur.id).update({ version: cur.version, ...cur.spec, Labels: { ...(cur.spec.Labels ?? {}), [MESH_CONTROL_LEASE_LABEL]: value } });
    return result;
  } catch (e) {
    if (!isOutOfSequence(e) && !isAlreadyExists(e)) throw e;
    const live = (await readMeshLease(api))?.record ?? null;
    return { ok: false, lease: live, reason: casLossReason(op, live) };
  }
}
