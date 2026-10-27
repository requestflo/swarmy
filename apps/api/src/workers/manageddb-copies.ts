import { COPY_PROBE_SQL, PG_PASSWORD_FROM_MEMBER, PG_PROMOTE_SQL, parseCopyProbe, type StandbyCopy } from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';

/**
 * The managed-Postgres failover's per-COPY IO (the rule is @swarmy/core
 * `manageddb-failover-copies`): find every running copy of a standby service,
 * probe each one on its own, and promote exactly ONE container, verifying it
 * in that same container. Nothing here execs in "a task of the service".
 */

const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const EXEC_TIMEOUT_MS = 15_000;
const IN_RECOVERY_SQL = 'SELECT pg_is_in_recovery()';

type Copy = Pick<StandbyCopy, 'service' | 'node' | 'containerId' | 'agent'>;

const psql = (sql: string): string => `${PG_PASSWORD_FROM_MEMBER} psql -U postgres -d postgres -tAc "${sql}"`;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Every running task container of `service` (org-scoped), with its agent and swarm node. */
export function runningCopies(orgId: string, service: Pick<SwarmServiceInfo, 'id' | 'name'>): Copy[] {
  const org = new Set(hub.liveInventory(orgId).containers.map((c) => c.id));
  const out: Copy[] = [];
  for (const agent of hub.onlineNodeIds()) {
    for (const c of hub.latestContainers(agent)) {
      if (!org.has(c.id) || c.state !== 'running') continue;
      if ((c.serviceId ?? c.labels?.[SWARM_SERVICE_ID_LABEL]) !== service.id) continue;
      out.push({ service: service.name, node: hub.swarmNodeIdFor(agent) ?? null, containerId: c.id, agent });
    }
  }
  return out.sort((a, b) => (a.node ?? '').localeCompare(b.node ?? '') || a.containerId.localeCompare(b.containerId));
}

/** `sh -c <script>` in exactly this container; null when it couldn't run. */
async function execCopy(copy: Copy, script: string, timeoutMs = EXEC_TIMEOUT_MS): Promise<{ exitCode: number; output: string } | null> {
  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      copy.agent,
      'exec',
      { target: { containerId: copy.containerId }, cmd: ['sh', '-c', script], tty: false, stream: false },
      { timeoutMs },
    );
    return { exitCode: res.exitCode, output: res.output ?? '' };
  } catch {
    return null;
  }
}

/** Probe every running copy of each standby on its own (no answer ⇒ all null). */
export async function probeCopies(orgId: string, standbys: readonly SwarmServiceInfo[]): Promise<StandbyCopy[]> {
  const out: StandbyCopy[] = [];
  for (const s of standbys) {
    for (const copy of runningCopies(orgId, s)) {
      const res = await execCopy(copy, psql(COPY_PROBE_SQL));
      const probe = res && res.exitCode === 0 ? parseCopyProbe(res.output) : null;
      out.push({ ...copy, ...(probe ?? { inRecovery: null, replayLsn: null, lagSeconds: null }) });
    }
  }
  return out;
}

/** Is this copy out of recovery (a writer)? null = no answer. */
async function writes(copy: Copy): Promise<boolean | null> {
  const res = await execCopy(copy, psql(IN_RECOVERY_SQL));
  if (!res || res.exitCode !== 0) return null;
  const v = res.output.trim();
  return v.startsWith('f') ? true : v.startsWith('t') ? false : null;
}

/**
 * Promote exactly this copy: `pg_promote()` in ITS container, verified in that
 * same container. A copy that already writes (a pass resumed after the exec
 * landed) is not promoted again. True once it writes.
 */
export async function promoteCopy(copy: Copy, timeoutMs: number, verifyEveryMs = 2_000): Promise<boolean> {
  if ((await writes(copy)) === true) return true;
  const promote = await execCopy(copy, psql(PG_PROMOTE_SQL), timeoutMs);
  if (!promote || promote.exitCode !== 0) return false;
  for (let attempt = 0; attempt < 5; attempt++) {
    if ((await writes(copy)) === true) return true;
    await sleep(verifyEveryMs);
  }
  return false;
}
