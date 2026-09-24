import { describe, expect, it } from 'bun:test';
import { BASEBACKUP_OK_MARKER, STACK_LABEL } from '@swarmy/core';
import type { ContainerInfo, SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import {
  FREEZE_WRITES_SCRIPT,
  THAW_WRITES_SCRIPT,
  WRITER_CHECK_SCRIPT,
  basebackupRunOncePayload,
  migrateStorage,
} from './manageddb.service';

/**
 * db.migrateStorage — the ONLINE copy redesign. The live data-loss bug: the old
 * flow scaled the primary to 0 (swarm then REMOVES the task container with its
 * anonymous volume), copied nothing, and "rolled back" by mounting the
 * anonymous volume BY NAME — which creates a fresh EMPTY volume. These tests pin
 * the invariants: the primary is never stopped/scaled before a verified copy,
 * and no path ever deploys a spec that mounts the legacy volume by name.
 */

const STACK = 'hello';
const CLUSTER = 'main';
const PRIMARY = 'hello_main-primary';
const REPLICA = 'hello_main-replica';
const NET = 'hello_main-net';
const TARGET = 'hello_main-primary-data';
const ANON = '3f1c0ffeeanonymousvolumehash';
const IMAGE = 'pgvector/pgvector:pg17';

interface Call {
  nodeId: string;
  cmd: string;
  payload: Record<string, unknown>;
}

function svc(name: string, role: 'primary' | 'replica', mounts: SwarmServiceInfo['mounts'], env: string[]): SwarmServiceInfo {
  return {
    id: `id-${name}`,
    name,
    image: IMAGE,
    mode: 'replicated',
    desiredReplicas: 1,
    runningReplicas: 1,
    createdAt: 1,
    updatedAt: 1,
    labels: {
      [STACK_LABEL]: STACK,
      'swarmy.managed': 'true',
      'swarmy.db.engine': 'postgres',
      'swarmy.db.cluster': CLUSTER,
      'swarmy.db.role': role,
    },
    networks: [{ name: NET, aliases: [] }],
    env,
    ports: [],
    secrets: [],
    configs: [],
    mounts,
  } as SwarmServiceInfo;
}

function container(id: string, serviceId: string, source: string): ContainerInfo {
  return {
    id,
    name: id,
    image: IMAGE,
    state: 'running',
    status: 'Up',
    createdAt: 1,
    ports: [],
    labels: { 'com.docker.swarm.service.id': serviceId },
    serviceId,
    mounts: [{ type: 'volume', source, target: '/var/lib/postgresql/data' }],
  } as ContainerInfo;
}

const PRIMARY_ENV = [
  'SWARMY_PG_ROLE=primary',
  'SWARMY_PG_REPLICATION_USER=repl',
  'SWARMY_PG_REPLICATION_PASSWORD=replpw',
  'POSTGRES_PASSWORD=pw',
  'POSTGRES_DB=app',
];

interface Behaviour {
  copy?: { exitCode: number; output: string; timedOut?: boolean };
  /** service.deploy of the primary throws; `applied` = swarm took the new spec anyway. */
  deployFails?: { applied: boolean };
  /** The new task never comes up. */
  newTaskNeverRuns?: boolean;
  primaryEnv?: string[];
}

function harness(b: Behaviour = {}) {
  const calls: Call[] = [];
  let primary = svc(PRIMARY, 'primary', [], b.primaryEnv ?? PRIMARY_ENV);
  const replica = svc(REPLICA, 'replica', [], ['SWARMY_PG_ROLE=replica']);
  // node-a hosts the primary's task (anonymous volume); node-b the replica.
  const containers: Record<string, ContainerInfo[]> = {
    'node-a': [container('c-old', primary.id, ANON)],
    'node-b': [container('c-rep', replica.id, 'anon-replica')],
  };

  const applyCutover = () => {
    primary = { ...primary, mounts: [{ type: 'volume', source: TARGET, target: '/var/lib/postgresql/data' }] };
    // swarm removes the old task container WITH its anonymous volume.
    containers['node-a'] = b.newTaskNeverRuns ? [] : [container('c-new', primary.id, TARGET)];
  };

  const hub = {
    liveInventory: () => ({
      services: [primary, replica],
      containers: Object.values(containers).flat(),
    }),
    onlineNodeIds: () => Object.keys(containers),
    latestContainers: (nodeId: string) => containers[nodeId] ?? [],
    managerNode: () => 'node-a',
    isOnline: () => true,
    swarmNodeIdFor: (nodeId: string) => `swarm-${nodeId}`,
    nodeInventory: () => [{ swarmNodeId: 'swarm-node-a' }, { swarmNodeId: 'swarm-node-b' }],
    dispatch: async (nodeId: string, cmd: string, payload: Record<string, unknown>) => {
      calls.push({ nodeId, cmd, payload });
      // SQL (freeze / thaw / writer check) is a bind-less runOnce psql client.
      if (cmd === 'container.runOnce' && !payload.binds) {
        const script = (payload.cmd as string[])[0];
        if (script === WRITER_CHECK_SCRIPT) return { exitCode: 0, output: 'false|off\n', durationMs: 1, timedOut: false };
        return { exitCode: 0, output: '', durationMs: 1, timedOut: false };
      }
      if (cmd === 'container.runOnce') {
        return b.copy ?? { exitCode: 0, output: `${BASEBACKUP_OK_MARKER} pg=16 kb=9000\n`, durationMs: 1, timedOut: false };
      }
      if (cmd === 'service.deploy') {
        const spec = payload.spec as { name: string };
        if (spec.name === PRIMARY) {
          if (b.deployFails) {
            if (b.deployFails.applied) applyCutover();
            throw new Error('dispatch timed out');
          }
          applyCutover();
        }
        return {};
      }
      return {};
    },
  };
  const ctx = {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    hub,
    db: { auditLog: { create: async () => ({}) } },
  } as unknown as OrgContext;
  return { ctx, calls };
}

const run = (ctx: OrgContext, extra: Partial<Parameters<typeof migrateStorage>[1]> = {}) =>
  migrateStorage(ctx, { stack: STACK, cluster: CLUSTER, skipBackup: true, ...extra }, {
    pollMs: 1,
    cutoverWaitMs: 20,
  });

/** No dispatch that can stop, scale or remove the live primary. */
function expectPrimaryUntouched(calls: Call[]) {
  for (const c of calls) {
    expect(['service.scale', 'service.remove', 'service.deploy', 'service.update']).not.toContain(c.cmd);
  }
}

/** No deploy EVER mounts the legacy anonymous volume by name. */
function expectNoMountBySourceName(calls: Call[]) {
  for (const c of calls.filter((x) => x.cmd === 'service.deploy')) {
    const mounts = ((c.payload.spec as { mounts?: Array<{ source?: string }> }).mounts ?? []);
    expect(mounts.map((m) => m.source)).not.toContain(ANON);
  }
}

const execScripts = (calls: Call[]) =>
  calls
    .filter((c) => c.cmd === 'container.runOnce' && !c.payload.binds)
    .map((c) => (c.payload.cmd as string[])[0]);

describe('basebackupRunOncePayload — golden', () => {
  it('online pg_basebackup on the cluster overlay into the named volume, env-only creds', () => {
    const p = basebackupRunOncePayload({
      image: IMAGE,
      primaryService: PRIMARY,
      network: NET,
      dataVolume: TARGET,
      replicationUser: 'repl',
      replicationPassword: 'replpw',
      stamp: '42',
      timeoutMs: 1000,
    });
    expect(p).toMatchObject({
      image: IMAGE,
      entrypoint: ['/bin/sh', '-c'],
      env: { SRC_HOST: PRIMARY, PGUSER: 'repl', PGPASSWORD: 'replpw' },
      binds: [`${TARGET}:/var/lib/postgresql/data`],
      networks: [NET],
      user: '0:0',
      pull: false,
      timeoutMs: 1000,
    });
    const script = p.cmd![0]!;
    expect(script).toContain('pg_basebackup -h "$SRC_HOST" -p 5432 -U "$PGUSER" -w -D /var/lib/postgresql/data/pgdata -X stream -c fast -P');
    expect(script).toContain('chown -R postgres:postgres /var/lib/postgresql/data');
    expect(script).not.toContain('replpw'); // never argv
  });
});

describe('migrateStorage — online copy, stop only after verification', () => {
  it('happy path: freeze → runOnce on the primary node → cutover deploy (mount + pin) → verify → replicas', async () => {
    const { ctx, calls } = harness();
    const res = await run(ctx);
    expect(res).toMatchObject({
      outcome: 'migrated',
      dataVolume: TARGET,
      pinnedNode: 'swarm-node-a',
      sourceVolume: ANON,
      writesFrozen: true,
    });

    const seq = calls.map((c) => c.cmd);
    // The copy is the runOnce that binds the named volume (SQL runOnces bind nothing).
    const copyIdx = calls.findIndex((c) => c.cmd === 'container.runOnce' && Boolean(c.payload.binds));
    const firstDeploy = seq.indexOf('service.deploy');
    expect(copyIdx).toBeGreaterThan(-1);
    expect(copyIdx).toBeLessThan(firstDeploy);
    expect(seq).not.toContain('service.scale');
    expect(execScripts(calls)[0]).toBe(FREEZE_WRITES_SCRIPT);

    const copy = calls[copyIdx]!;
    expect(copy.nodeId).toBe('node-a'); // the node hosting the running primary task
    expect(copy.payload).toMatchObject({
      image: IMAGE,
      networks: [NET],
      binds: [`${TARGET}:/var/lib/postgresql/data`],
      user: '0:0',
      env: { SRC_HOST: PRIMARY, PGUSER: 'repl', PGPASSWORD: 'replpw' },
    });

    const cut = calls[firstDeploy]!.payload.spec as {
      name: string;
      mounts: Array<{ source: string; target: string }>;
      placement: { constraints: string[] };
      labels: Record<string, string>;
    };
    expect(cut.name).toBe(PRIMARY);
    expect(cut.mounts).toEqual([{ type: 'volume', source: TARGET, target: '/var/lib/postgresql/data' }] as never);
    expect(cut.placement.constraints).toEqual(['node.id==swarm-node-a']);
    expect(cut.labels['swarmy.db.dataVolume']).toBe(TARGET);

    expect(execScripts(calls)).toContain(WRITER_CHECK_SCRIPT);
    const replicaDeploy = calls.filter((c) => c.cmd === 'service.deploy')[1]!.payload.spec as { name: string };
    expect(replicaDeploy.name).toBe(REPLICA);
    expectNoMountBySourceName(calls);
  });

  it('allowWritesDuringCopy skips the freeze', async () => {
    const { ctx, calls } = harness();
    const res = await run(ctx, { allowWritesDuringCopy: true });
    expect(res.writesFrozen).toBe(false);
    expect(execScripts(calls)).not.toContain(FREEZE_WRITES_SCRIPT);
  });

  it('copy failure BEFORE cutover leaves the primary untouched (thawed, never stopped)', async () => {
    const { ctx, calls } = harness({
      copy: { exitCode: 1, output: 'pg_basebackup: error: connection refused', timedOut: false },
    });
    const err = await run(ctx).then(
      () => null,
      (e: Error) => e,
    );
    expect(err).not.toBeNull();
    expect(err!.message).toContain('aborted before cutover');
    expect(err!.message).toContain('never stopped');
    expect(err!.message).not.toContain('no data was discarded');
    expectPrimaryUntouched(calls);
    expect(execScripts(calls)).toEqual([FREEZE_WRITES_SCRIPT, THAW_WRITES_SCRIPT]);
  });

  it('exit 0 without the PGDATA verification marker is still a failure before cutover', async () => {
    const { ctx, calls } = harness({ copy: { exitCode: 0, output: 'something odd', timedOut: false } });
    await expect(run(ctx)).rejects.toThrow(/aborted before cutover/);
    expectPrimaryUntouched(calls);
  });

  it('preflight: no replication credentials → nothing dispatched at all', async () => {
    const { ctx, calls } = harness({ primaryEnv: ['POSTGRES_PASSWORD=pw'] });
    await expect(run(ctx)).rejects.toThrow(/nothing was changed/);
    expect(calls).toEqual([]);
  });

  it('cutover dispatch fails but never applied → original writer verified, thawed, no rollback deploy', async () => {
    const { ctx, calls } = harness({ deployFails: { applied: false } });
    const err = await run(ctx).then(() => null, (e: Error) => e);
    expect(err!.message).toContain('cutover did not apply');
    expect(err!.message).toContain(TARGET);
    expect(calls.filter((c) => c.cmd === 'service.deploy')).toHaveLength(1); // only the attempted cutover
    expect(execScripts(calls).at(-1)).toBe(THAW_WRITES_SCRIPT);
    expectNoMountBySourceName(calls);
  });

  it('cutover applied but errored → loud manual-recovery error, NO redeploy of the old spec', async () => {
    const { ctx, calls } = harness({ deployFails: { applied: true } });
    const err = await run(ctx).then(() => null, (e: Error) => e);
    expect(err!.message).toContain('CUTOVER FAILED');
    expect(err!.message).toContain(TARGET);
    expect(err!.message).toContain('do NOT redeploy the old spec');
    expect(err!.message).not.toMatch(/no data was discarded|data is safe/);
    expect(calls.filter((c) => c.cmd === 'service.deploy')).toHaveLength(1);
    expectNoMountBySourceName(calls);
  });

  it('new writer never comes up → loud error naming the verified copy, no rollback by volume name', async () => {
    const { ctx, calls } = harness({ newTaskNeverRuns: true });
    const err = await run(ctx).then(() => null, (e: Error) => e);
    expect(err!.message).toContain('CUTOVER FAILED');
    expect(err!.message).toContain(`copy volume ${TARGET} on swarm node swarm-node-a`);
    expect(calls.filter((c) => c.cmd === 'service.deploy')).toHaveLength(1);
    expectNoMountBySourceName(calls);
  });
});
