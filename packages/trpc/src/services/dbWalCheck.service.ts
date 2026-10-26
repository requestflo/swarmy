/**
 * The WAL continuity check of a wal-g PITR cluster (board 40: "WAL
 * continuous · 0 gaps", or the gap a restore cannot land inside).
 *
 * The agent on the node that holds the cluster's data runs a read-only
 * `wal-g wal-verify integrity timeline` in a sidecar (`db.walVerify`). The
 * archive lives off-box (S3), which no streamed snapshot carries, so this is
 * a command like `db.pitrWindow`. An agent that predates it would drop the
 * frame, so it is sent only to an agent that advertised `dbWalVerify`; the
 * view is `unsupported` otherwise. wal-verify asks the live primary for its
 * current segment, so the password is read from the cluster's secret, and
 * only once the agent is known to support the command.
 *
 * Reads are shared through the process-memory cache (`dbWalCheck.cache.ts`):
 * the dashboard, the restore preflight and the Resilience check.
 */
import { AGENT_CAPABILITY, DbWalVerifyResult, agentSupports } from '@swarmy/core/protocol';
import type { DbConnection, ResticRepo } from '@swarmy/core/protocol';
import type { DbWalCheckView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { mapDispatchError } from '../errors';
import { walgClusterRead } from './dbBackup.service';
import { WAL_CHECK_REUSE_MS, claimWalRefresh, knownWalCheck, rememberWalCheck } from './dbWalCheck.cache';
import { walCheckView, type WalCheckRead } from './dbWalCheck.judge';

export interface WalCheckRequest {
  nodeId: string;
  repo: ResticRepo;
  network?: string;
  resticNetwork?: string;
  conn: () => Promise<DbConnection>;
}

/** Ask the agent to verify the archive, only when it advertised the command. Throws when the read fails. */
export async function readWalCheck(ctx: OrgContext, req: WalCheckRequest): Promise<WalCheckRead> {
  const build = ctx.hub.agentBuildFor?.(req.nodeId);
  if (!agentSupports(build?.capabilities, AGENT_CAPABILITY.dbWalVerify)) {
    const which = build?.version ? `agent ${build.version}` : 'agent';
    return { status: 'unsupported', reason: `the ${which} on node ${req.nodeId} cannot verify the WAL archive (it predates dbWalVerify)` };
  }
  const raw = await ctx.hub.dispatch<unknown>(req.nodeId, 'db.walVerify', {
    engine: 'wal-g',
    repo: req.repo,
    conn: await req.conn(),
    network: req.network,
    resticNetwork: req.resticNetwork,
  });
  const parsed = DbWalVerifyResult.safeParse(raw);
  if (!parsed.success) throw new Error('the agent answered the WAL check with something unreadable');
  return { status: 'read', result: parsed.data };
}

/** Read (or reuse a read from the last few minutes) and remember it. */
async function checkCluster(ctx: OrgContext, stack: string, cluster: string): Promise<WalCheckRead | null> {
  const ref = `${stack}/${cluster}`;
  const fresh = knownWalCheck(ctx.activeOrgId, ref, Date.now(), WAL_CHECK_REUSE_MS);
  if (fresh) return { status: 'read', result: fresh };
  const where = await walgClusterRead(ctx, stack, cluster);
  if (!where) return null;
  const read = await readWalCheck(ctx, where);
  if (read.status === 'read') rememberWalCheck(ctx.activeOrgId, ref, read.result);
  return read;
}

/** `dbBackups.walCheck`: the cluster's WAL continuity, `none` for a cluster without wal-g PITR. */
export async function getDbWalCheck(ctx: OrgContext, input: { stack: string; cluster: string }): Promise<DbWalCheckView> {
  try {
    return walCheckView(await checkCluster(ctx, input.stack, input.cluster));
  } catch (e) {
    throw mapDispatchError(e);
  }
}

/**
 * Keep the Resilience check current without making the page wait: start a
 * read of each listed cluster whose last one is older than half an hour (at
 * most one try per cluster in that time). Never throws, never awaits.
 */
export function refreshWalChecks(ctx: OrgContext, refs: ReadonlyArray<{ stack: string; cluster: string }>): void {
  for (const r of refs) {
    if (!claimWalRefresh(ctx.activeOrgId, `${r.stack}/${r.cluster}`)) continue;
    void checkCluster(ctx, r.stack, r.cluster).catch(() => undefined);
  }
}
