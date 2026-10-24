/**
 * Registry GC agent steps: delete through the API, and the read-only sweep
 * window (see `registry-gc.spec.ts` for the procedure, `registry-gc.scripts.ts`
 * for the one-shots). Every step is an existing agent command — `service.deploy`
 * on a manager, `container.runOnce` on the node that holds the volume — so the
 * controller never touches a node socket.
 */
import type { RunOnceResult } from '@swarmy/core/protocol';
import { systemImage } from '@swarmy/core/system-images';
import type { AgentHub } from '../hub/types';
import type { RegistryCreds } from './registry-auth';
import { isTaskOf, type RegistryTarget } from './registry-gc.live';
import type { RegistryDelete } from './registry-gc.plan';
import { registryMaintenanceSpec } from './registry-gc.spec';
import {
  parseRegistryOutput,
  renderRegistryCollectScript,
  renderRegistryDeleteScript,
  type RegistryStats,
} from './registry-gc.scripts';

/** One-shot in the registry's own image on the volume's node (image is present: the task runs it). */
export function runOnRegistryNode(hub: AgentHub, t: RegistryTarget, script: string, readOnly: boolean) {
  return hub.dispatch<RunOnceResult>(
    t.nodeId,
    'container.runOnce',
    {
      image: t.live.image,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [script],
      binds: [`${t.volume}:/var/lib/registry${readOnly ? ':ro' : ''}`],
      networks: ['none'],
      pull: false,
      timeoutMs: 30 * 60_000,
    },
    { timeoutMs: 31 * 60_000 },
  );
}

/** Delete manifests through the registry API (regctl on a manager, host network). Returns `repo@digest`s deleted. */
export async function deleteManifests(
  hub: AgentHub,
  t: Pick<RegistryTarget, 'manager'>,
  host: string,
  creds: RegistryCreds | null,
  deletes: readonly RegistryDelete[],
): Promise<string[]> {
  if (!deletes.length) return [];
  const res = await hub.dispatch<RunOnceResult>(
    t.manager,
    'container.runOnce',
    {
      image: systemImage('regctl').ref,
      entrypoint: ['/bin/sh', '-c'],
      cmd: [renderRegistryDeleteScript(deletes, host)],
      env: creds ? { SWARMY_REG_USER: creds.username, SWARMY_REG_PASS: creds.password } : {},
      networks: ['host'],
      timeoutMs: 15 * 60_000,
    },
    { timeoutMs: 16 * 60_000 },
  );
  return parseRegistryOutput(res.output).deleted;
}

/** Put the registry back to read-write (retries; an interrupted window is also healed next tick). */
export async function endMaintenance(hub: AgentHub, t: Pick<RegistryTarget, 'live' | 'swarmNodeId' | 'manager'>): Promise<boolean> {
  const spec = registryMaintenanceSpec(t.live, t.swarmNodeId, false);
  if (!spec) return false;
  for (let i = 0; i < 3; i++) {
    const ok = await hub.dispatch(t.manager, 'service.deploy', { spec, pullPolicy: 'missing' }).then(() => true, () => false);
    if (ok) return true;
  }
  return false;
}

export interface SweepResult {
  ok: boolean;
  error?: string;
  stats: RegistryStats | null;
  reclaimedBytes: number | null;
}

/**
 * Read-only window: redeploy read-only (pinned), wait until the old
 * read-write task is GONE and a new task runs, `garbage-collect`, then always
 * restore read-write. Pulls keep working throughout; pushes are refused for
 * the window (a build that starts mid-window fails its push and can be re-run).
 */
export async function sweepRegistry(
  hub: AgentHub,
  t: RegistryTarget,
  sleep: (ms: number) => Promise<void>,
): Promise<SweepResult> {
  const fail = (error: string): SweepResult => ({ ok: false, error, stats: null, reclaimedBytes: null });
  const ro = registryMaintenanceSpec(t.live, t.swarmNodeId, true);
  if (!ro) return fail('the registry has no login to redeploy with yet');
  try {
    await hub.dispatch(t.manager, 'service.deploy', { spec: ro, pullPolicy: 'missing' });
    if (!(await waitForNewTask(hub, t, sleep))) return fail('the read-only registry did not start');
    const out = parseRegistryOutput((await runOnRegistryNode(hub, t, renderRegistryCollectScript(), false)).output);
    if (out.gcExit !== 0) return fail(`garbage-collect exited ${out.gcExit ?? 'without a status'}`);
    const reclaimed = out.beforeBytes !== null && out.stats ? Math.max(0, out.beforeBytes - out.stats.sizeBytes) : null;
    return { ok: true, stats: out.stats, reclaimedBytes: reclaimed };
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    await endMaintenance(hub, t);
  }
}

/** Poll the volume node's containers (agents report every ~4s) for up to ~2 min. */
async function waitForNewTask(hub: AgentHub, t: RegistryTarget, sleep: (ms: number) => Promise<void>): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    await sleep(2_000);
    const tasks = hub.latestContainers(t.nodeId).filter((c) => isTaskOf(c, t.live) && c.state === 'running');
    if (tasks.length > 0 && tasks.every((c) => c.id !== t.containerId)) return true;
  }
  return false;
}
