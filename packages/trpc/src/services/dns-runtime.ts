/**
 * swarmy-dns runtime status — the "is DNS actually serving, and if not WHY"
 * answer behind `geodns.getConfig().runtime` (same idea as the ingress edge's
 * `runtime`). Before this, the page said "enabled" while every task was
 * failing to bind :53 and pushes went to "0 node(s), 2 failed" with no reason.
 *
 * Pure derive + a tiny in-memory record of the last deploy and the last push
 * outcome PER NODE (process-local, like ingress `lastApplyByOrg`: it is
 * operational telemetry, not state — a controller restart re-learns it on the
 * next reconcile tick). No imports of the push/deploy services, so both can
 * record here without a cycle.
 */

export const DNS_START_GRACE_MS = 2 * 60_000;

export type DnsRuntimeState = 'paused' | 'deploying' | 'down' | 'degraded' | 'serving';

export interface DnsDeployRecord {
  ok: boolean;
  at: number;
  message?: string;
}

export interface DnsNodePushRecord {
  ok: boolean;
  at: number;
  error?: string;
}

const lastDeployByOrg = new Map<string, DnsDeployRecord>();
const lastPushByOrg = new Map<string, Map<string, DnsNodePushRecord>>();

export function recordDnsDeploy(orgId: string, ok: boolean, message?: string): void {
  lastDeployByOrg.set(orgId, { ok, at: Date.now(), ...(message ? { message } : {}) });
}

export function recordDnsPush(
  orgId: string,
  pushed: string[],
  failed: Array<{ nodeId: string; error: string }>,
): void {
  const at = Date.now();
  const byNode = lastPushByOrg.get(orgId) ?? new Map<string, DnsNodePushRecord>();
  for (const nodeId of pushed) byNode.set(nodeId, { ok: true, at });
  for (const f of failed) byNode.set(f.nodeId, { ok: false, at, error: f.error });
  lastPushByOrg.set(orgId, byNode);
}

export function lastDnsDeploy(orgId: string): DnsDeployRecord | undefined {
  return lastDeployByOrg.get(orgId);
}

export function lastDnsPushes(orgId: string): ReadonlyMap<string, DnsNodePushRecord> {
  return lastPushByOrg.get(orgId) ?? new Map();
}

/** Test seam. */
export function resetDnsRuntimeRecords(): void {
  lastDeployByOrg.clear();
  lastPushByOrg.clear();
}

export interface DnsRuntimeInput {
  enabled: boolean;
  /** Live swarmy-dns service from hub inventory (undefined = not deployed). */
  service?: {
    runningTasks: number;
    /** Spec update time (ms) — task errors older than this are history. */
    updatedAt?: number;
    recentFailures: number;
    lastError?: string;
    lastErrorAt?: number;
    starting: boolean;
  };
  /** Online ingress+outlet nodes — where a swarmy-dns task SHOULD run. */
  nodes: Array<{ nodeId: string; hostname: string; dnsRunning: boolean | null }>;
  lastDeploy?: DnsDeployRecord;
  pushes: ReadonlyMap<string, DnsNodePushRecord>;
  now: number;
}

export interface DnsRuntimeNode {
  nodeId: string;
  hostname: string;
  /** Local task running (agent `docker ps`); null = no report yet. */
  dnsRunning: boolean | null;
  lastPush: { ok: boolean; at: string; error: string | null } | null;
}

export interface DnsRuntimeStatus {
  state: DnsRuntimeState;
  serving: boolean;
  message: string;
  runningTasks: number;
  expectedTasks: number;
  /** Most recent CURRENT task error (`docker service ps` ERROR), if any. */
  taskError: string | null;
  deployError: string | null;
  nodes: DnsRuntimeNode[];
}

const hostList = (xs: string[]): string => xs.join(', ');

export function deriveDnsRuntime(input: DnsRuntimeInput): DnsRuntimeStatus {
  const svc = input.service;
  const running = svc?.runningTasks ?? 0;
  // A task error only matters if it happened under the CURRENT spec: after a
  // fix is rolled out, the old "address already in use" must stop showing.
  const taskError =
    svc?.lastError && svc.recentFailures > 0 && (svc.lastErrorAt ?? 0) >= (svc.updatedAt ?? 0)
      ? svc.lastError
      : null;
  const deployError = input.lastDeploy && !input.lastDeploy.ok ? (input.lastDeploy.message ?? 'unknown error') : null;
  const nodes: DnsRuntimeNode[] = input.nodes.map((n) => {
    const p = input.pushes.get(n.nodeId);
    return {
      ...n,
      lastPush: p ? { ok: p.ok, at: new Date(p.at).toISOString(), error: p.error ?? null } : null,
    };
  });
  const base = { runningTasks: running, expectedTasks: input.nodes.length, taskError, deployError, nodes };
  const out = (state: DnsRuntimeState, message: string): DnsRuntimeStatus => ({
    ...base,
    state,
    serving: state === 'serving',
    message,
  });
  const taskSuffix = taskError ? ` Task error: ${taskError}` : '';

  if (!input.enabled) return out('paused', 'Geo-DNS is off — swarmy-dns is not deployed.');
  if (deployError && !svc) return out('down', `Could not deploy swarmy-dns: ${deployError}`);
  if (!svc) return out('down', 'swarmy-dns is not deployed yet — nothing answers on :53.');
  if (input.nodes.length === 0) {
    return out(
      'down',
      'No online node is marked ingress + outlet, so swarmy-dns has nowhere to run. Mark at least two nodes to serve DNS.',
    );
  }

  if (running === 0) {
    const young = svc.updatedAt !== undefined && input.now - svc.updatedAt < DNS_START_GRACE_MS;
    if (!taskError && (svc.starting || young)) {
      return out('deploying', 'swarmy-dns is starting (pulling image / scheduling).');
    }
    return out(
      'down',
      `swarmy-dns has no running task — nothing answers on :53.${taskSuffix || ' Check `docker service ps swarmy-dns --no-trunc`.'}`,
    );
  }

  const notRunning = nodes.filter((n) => n.dnsRunning === false).map((n) => n.hostname);
  if (notRunning.length > 0 || running < input.nodes.length) {
    const where = notRunning.length ? ` Not running on ${hostList(notRunning)}.` : '';
    return out(
      'degraded',
      `swarmy-dns is running on ${running} of ${input.nodes.length} DNS node(s).${where}${taskSuffix}`,
    );
  }

  const failedPush = nodes.filter((n) => n.lastPush && !n.lastPush.ok);
  if (failedPush.length > 0) {
    const why = failedPush.map((n) => `${n.hostname}: ${n.lastPush!.error}`).join('; ');
    return out('degraded', `swarmy-dns is running, but the last zone push failed — ${why}`);
  }
  if (deployError) {
    return out('degraded', `swarmy-dns is running, but the last converge failed: ${deployError}`);
  }
  return out('serving', `swarmy-dns is answering on ${hostList(nodes.map((n) => n.hostname))}.`);
}
