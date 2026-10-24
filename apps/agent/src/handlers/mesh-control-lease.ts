/**
 * The mesh control-plane lease, run by the agent of the node that holds a
 * control-plane spec (rules: @swarmy/core/protocol mesh-control-lease.ts;
 * the object: mesh-control-lease-store.ts). Every 10 s (daemon.ts) through
 * this manager's own socket, so it needs no controller. Each confirmed renewal
 * arms a timer for TTL − margin after it was SENT: no newer one by then, and
 * Litestream is killed (no final sync). Process memory only.
 */
import type { DockerClient } from '@swarmy/core/docker';
import { MESH_LEASE, meshLeaseOutcome, meshLeaseStep, meshMayReplicate, observeMeshLease, replicaFenceAt } from '@swarmy/core/protocol';
import type { ControllerLeaseRecord, MeshControlLeaseView, MeshLeaseObservation, MeshLeaseRead } from '@swarmy/core/protocol';
import { env } from '../env';
import { leaseIdentity, readMeshLease, writeMeshLease, type LeaseApi, type LeaseOp, type LeaseSelf } from './mesh-control-lease-store';

export interface LeaseHooks {
  /** Another node holds the lease: stop this node's control plane and forget it (never releases). */
  fence(why: string): Promise<void>;
  /** The lease may have run out: kill Litestream now, no final sync. */
  killReplica(): Promise<void>;
  log(msg: string): void;
}

type Mem = {
  state: MeshControlLeaseView['state'];
  self: LeaseSelf | null;
  epoch: number | null;
  lastOkSentAt: number | null;
  obs: MeshLeaseObservation | null;
  managers: number | null;
  intent: boolean;
  holder: ControllerLeaseRecord | null;
  why?: string;
};
const fresh = (managers: number | null = null): Mem => ({ state: 'silent', self: null, epoch: null, lastOkSentAt: null, obs: null, managers, intent: false, holder: null });
let mem = fresh();
let fenceTimer: ReturnType<typeof setTimeout> | null = null;
let chain: Promise<unknown> = Promise.resolve();
const now = () => performance.now();
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const who = (r: ControllerLeaseRecord) => `${r.hostname ?? r.node} (epoch ${r.epoch})`;

/** One lease operation at a time (the 10 s tick, an apply, a stop). */
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.catch(() => undefined);
  return p;
}

export function mayReplicate(): boolean {
  return meshMayReplicate(mem, now());
}

/** A takeover the controller asked for is still waiting (keep its observation). */
export function leasePending(): boolean {
  return mem.intent;
}

export function leaseView(): MeshControlLeaseView {
  const h = mem.holder;
  return {
    state: mem.state,
    ...(mem.epoch != null ? { epoch: mem.epoch } : h ? { epoch: h.epoch } : {}),
    ...(h ? { holderNode: h.node, ...(h.hostname ? { holderHostname: h.hostname } : {}) } : {}),
    ...(mem.lastOkSentAt != null ? { ageMs: Math.max(0, Math.round(now() - mem.lastOkSentAt)) } : {}),
    replicate: mayReplicate(),
    ...(mem.why ? { why: mem.why } : {}),
  };
}

/** No spec here any more (stopped or fenced): forget everything. */
export function resetLease(): void {
  if (fenceTimer) clearTimeout(fenceTimer);
  fenceTimer = null;
  mem = fresh(mem.managers);
}

async function identity(docker: DockerClient): Promise<LeaseSelf | string> {
  const id = await leaseIdentity(docker.docker as unknown as LeaseApi);
  if (typeof id !== 'string' && id.managers) mem.managers = id.managers;
  return id;
}

function setState(state: MeshControlLeaseView['state'], why?: string): MeshControlLeaseView {
  mem.state = state;
  mem.why = why;
  return leaseView();
}

function armFence(hooks: LeaseHooks): void {
  if (fenceTimer) clearTimeout(fenceTimer);
  const sent = mem.lastOkSentAt;
  if (sent == null) return;
  fenceTimer = setTimeout(() => {
    if (mem.lastOkSentAt !== sent || mem.managers === 1) return;
    setState('silent', `no confirmed lease renewal for ${Math.round((now() - sent) / 1000)} s`);
    hooks.log(`mesh control plane: FENCED replication: ${mem.why}; Litestream killed (no final sync), NetBird left running`);
    void hooks.killReplica().catch((e) => hooks.log(`mesh control plane: killing Litestream failed: ${msg(e)}`));
  }, Math.max(0, replicaFenceAt(sent) - now()));
  fenceTimer.unref?.();
}

async function lost(hooks: LeaseHooks, holder: ControllerLeaseRecord, why: string): Promise<MeshControlLeaseView> {
  resetLease();
  mem.holder = holder;
  const view = setState('lost', why);
  hooks.log(`mesh control plane: FENCED: ${why}. Stopping it here and forgetting its config.`);
  await hooks.fence(why).catch((e) => hooks.log(`mesh control plane: fence failed: ${msg(e)}`));
  return view;
}

const RETRY = 'no confirmed answer yet; retrying';

async function tickOnce(docker: DockerClient, hooks: LeaseHooks, intent: boolean): Promise<MeshControlLeaseView> {
  if (intent) mem.intent = true;
  if (!env.MESH_CONTROL_LEASE) return setState('unleased', 'SWARMY_MESH_CONTROL_LEASE=off');
  const self = await identity(docker).catch((e: unknown) => ({ silent: msg(e) }));
  if (typeof self === 'string') return setState('unleased', self);
  if ('silent' in self) return setState('silent', self.silent);
  mem.self = self;
  const api = docker.docker as unknown as LeaseApi;
  const read: MeshLeaseRead = await readMeshLease(api).then(
    (o) => ({ ok: true as const, record: o?.record ?? null }),
    (e: unknown) => ({ ok: false as const, why: msg(e) }),
  );
  if (read.ok) {
    mem.obs = observeMeshLease(mem.obs, read.record, now());
    if (read.record) mem.holder = read.record;
  }
  const step = meshLeaseStep({ read, self: self.holder, intent: mem.intent, obs: mem.obs, now: now() });
  // No answer from raft: `replicate` (the fence window) says whether Litestream may still ship.
  if (step.do === 'nothing') return setState('silent', step.why);
  if (step.do === 'wait') return setState('waiting', `held by ${who(step.holder)}; taking over in ${Math.ceil(step.waitMs / 1000)} s unless it is renewed`);
  if (step.do === 'fence') return lost(hooks, step.holder, step.why);
  const base = { holder: self.holder, node: self.holder, ...(self.hostname ? { hostname: self.hostname } : {}), ttlMs: MESH_LEASE.ttlMs };
  const op: LeaseOp =
    step.do === 'renew' ? { kind: 'lease.renew', ...base, epoch: step.epoch } : { kind: 'lease.acquire', ...base, expect: step.expect, minEpoch: mem.epoch ?? 0 };
  const sentAt = now();
  const out = meshLeaseOutcome(await writeMeshLease(api, op).catch(() => null), self.holder);
  if (out.kind === 'lost') {
    mem.holder = out.lease;
    return mem.intent ? setState('waiting', `held by ${who(out.lease)}`) : lost(hooks, out.lease, `the lease went to ${who(out.lease)}`);
  }
  if (out.kind === 'retry') return setState('silent', RETRY);
  if (mem.epoch !== out.lease.epoch || mem.state !== 'held') hooks.log(`mesh control plane: lease held at epoch ${out.lease.epoch}${step.do === 'acquire' ? ` (${step.why})` : ''}`);
  Object.assign(mem, { epoch: out.lease.epoch, lastOkSentAt: sentAt, holder: out.lease, intent: false });
  armFence(hooks);
  return setState('held');
}

/** Renew (or take) the lease once; a CAS race or no answer is retried 2 s later. */
export function leaseTick(docker: DockerClient, hooks: LeaseHooks, opts: { intent?: boolean } = {}): Promise<MeshControlLeaseView> {
  return serial(async () => {
    const v = await tickOnce(docker, hooks, opts.intent === true);
    if (v.why === RETRY) setTimeout(() => void leaseTick(docker, hooks), MESH_LEASE.retryMs).unref?.();
    return v;
  });
}

/** Before hosting (apply/restore): take the lease, waiting out another holder for up to `budgetMs`. */
export async function leaseForHosting(docker: DockerClient, hooks: LeaseHooks, budgetMs: number): Promise<MeshControlLeaseView> {
  const until = now() + budgetMs;
  for (let silent = 0; ; ) {
    const v = await leaseTick(docker, hooks, { intent: true });
    if (v.state === 'silent') silent++;
    if ((v.state !== 'waiting' && v.state !== 'silent') || silent > 2 || now() + 3_000 > until) return v;
    await Bun.sleep(3_000);
  }
}

/** Stopping here on purpose (a move, a fence by the controller): release it if it is ours, then forget it. */
export function releaseLease(docker: DockerClient): Promise<void> {
  return serial(async () => {
    const id = mem.self ?? (await identity(docker).catch(() => null));
    const self = id && typeof id !== 'string' ? id : null;
    const api = docker.docker as unknown as LeaseApi;
    const r = self ? (await readMeshLease(api).catch(() => null))?.record : null;
    if (self && r && r.holder === self.holder && !r.released) {
      await writeMeshLease(api, { kind: 'lease.release', holder: self.holder, epoch: r.epoch }).catch(() => undefined);
    }
    resetLease();
  });
}
