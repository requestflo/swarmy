/**
 * The raft lease + "Move controller to…" against a REAL Swarm, through the
 * REAL agent handler (apps/agent/src/handlers/controller-service.ts). Runs
 * inside a container that has a manager's Docker socket at /var/run/docker.sock
 * (see run.sh). The swarm needs two managers for the move check.
 */
import Docker from 'dockerode';
import { DockerClient } from '@swarmy/core/docker';
import { CONTROLLER_AVOID_CONSTRAINT, CONTROLLER_LEASE_LABEL, parseLeaseLabel, type ControllerServiceOp } from '@swarmy/core/protocol';
import { applyControllerService } from '../../../apps/agent/src/handlers/controller-service';

const SVC = 'e2e_controller';
const dc = new DockerClient('/var/run/docker.sock');
const raw = dc.docker as Docker;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const op = (o: ControllerServiceOp) => applyControllerService(dc, { commandId: crypto.randomUUID(), service: SVC, op: o });
const tasks = async () =>
  (await raw.listTasks({ filters: { service: [SVC], 'desired-state': ['running'] } })) as Array<{ ID: string; NodeID: string; Status: { State: string } }>;
async function runningTask(ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const t = (await tasks()).find((x) => x.Status.State === 'running');
    if (t) return t;
    await Bun.sleep(500);
  }
  throw new Error('no running task');
}

const existing = await dc.getServiceByName(SVC);
if (existing) await existing.remove();
for (const n of await raw.listNodes()) {
  const spec = n.Spec as { Labels?: Record<string, string> };
  if (spec.Labels?.['swarmy.controller.avoid']) {
    const i = (await raw.getNode(n.ID as string).inspect()) as { Version: { Index: number }; Spec: Record<string, unknown> & { Labels: Record<string, string> } };
    delete i.Spec.Labels['swarmy.controller.avoid'];
    await raw.getNode(n.ID as string).update({ version: i.Version.Index, ...i.Spec });
  }
}
await raw.createService({
  Name: SVC,
  Labels: { 'swarmy.system': 'true' },
  TaskTemplate: {
    ContainerSpec: {
      Image: 'busybox:latest',
      Command: ['sleep', '3600'],
      Env: ['LEASE_AT_START={{index .Service.Labels "swarmy.controller.lease"}}', 'TASK={{.Task.ID}}'],
    },
    Placement: { Constraints: ['node.role == manager', CONTROLLER_AVOID_CONSTRAINT] },
  },
  Mode: { Replicated: { Replicas: 1 } },
  UpdateConfig: { Order: 'stop-first' },
} as never);
const t0 = await runningTask();

// acquire / renew / CAS
const a = await op({ kind: 'lease.acquire', holder: 'task-a', node: 'node-a', ttlMs: 30000, minEpoch: 0, expect: null });
check('acquire on a fresh service', a.ok && a.lease?.epoch === 1, JSON.stringify(a.lease));
const racers = await Promise.all([
  op({ kind: 'lease.acquire', holder: 'task-b', node: 'node-b', ttlMs: 30000, minEpoch: 0, expect: a.lease }),
  op({ kind: 'lease.acquire', holder: 'task-c', node: 'node-c', ttlMs: 30000, minEpoch: 0, expect: a.lease }),
]);
const winners = racers.filter((r) => r.ok);
check('two concurrent takeovers of the same stale write: exactly one wins', winners.length === 1, racers.map((r) => `${r.ok}:${r.reason ?? r.lease?.holder}`).join(' '));
const winner = winners[0]!.lease!;
check('takeover bumps the epoch', winner.epoch === 2);
const renewOld = await op({ kind: 'lease.renew', holder: 'task-a', node: 'node-a', ttlMs: 30000, epoch: 1 });
check('the superseded holder cannot renew (epoch fencing)', !renewOld.ok && renewOld.reason === 'lost');
const renewNew = await op({ kind: 'lease.renew', holder: winner.holder, node: winner.node, ttlMs: 30000, epoch: 2 });
check('the new holder renews at the same epoch', renewNew.ok && renewNew.lease?.epoch === 2);
const t1 = await runningTask();
check('lease writes never restart the task', t1.ID === t0.ID, `${t0.ID} → ${t1.ID}`);
const rel = await op({ kind: 'lease.release', holder: winner.holder, epoch: 2 });
check('release marks the lease released', rel.ok && rel.lease?.released === true);
const svc = (await raw.getService(SVC).inspect()) as { Spec: { Labels: Record<string, string> } };
check('label holds the JSON record', parseLeaseLabel(svc.Spec.Labels[CONTROLLER_LEASE_LABEL])?.epoch === 2);

// move: needs two managers
const managers = (await raw.listNodes()).filter((n) => (n.Spec as { Role?: string }).Role === 'manager');
if (managers.length < 2) {
  console.log('SKIP move (needs 2 managers)');
} else {
  const from = (await runningTask()).NodeID;
  const target = managers.find((m) => m.ID !== from)!.ID as string;
  const mv = await op({ kind: 'move', targetNodeId: target, fromNodeId: from });
  check('move labels the other managers', mv.ok && (mv.labelled ?? []).includes(from), JSON.stringify(mv.labelled));
  const until = Date.now() + 90_000;
  let now = await runningTask();
  while (now.NodeID === from && Date.now() < until) {
    await Bun.sleep(1000);
    now = await runningTask().catch(() => now);
  }
  check('the constraint enforcer moved the task to the target', now.NodeID === target, `${from} → ${now.NodeID}`);
  const clr = await op({ kind: 'move.clear' });
  await Bun.sleep(5000);
  const after = await runningTask();
  check('clearing the avoid labels evicts nothing', clr.ok && after.ID === now.ID);
}

await raw.getService(SVC).remove();
console.log(failed ? `${failed} FAILED` : 'ALL PASS');
process.exit(failed ? 1 : 0);
