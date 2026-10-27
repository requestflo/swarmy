/**
 * The wal-g PITR leg of "also copy to" (board 40). wal-g writes WAL to one
 * storage (its failover storages are a fallback, not a second copy), so the
 * second destination is filled by `wal-g copy` after each scheduled base
 * backup: that base backup plus the WAL archived since it (`db.walgCopy`).
 * Between base backups the copy does not grow, so a restore from it reaches
 * as far as the last copy run: the agent reads the copy's own window back and
 * that end is the lag figure (`dbBackupCopy.view.ts`).
 *
 * An agent that predates the command would drop the frame, so it is sent
 * only to one that advertised `dbWalgCopy`; otherwise the copy fails with a
 * plain reason (stamped like any failed copy, never failing the save).
 */
import { AGENT_CAPABILITY, DbWalgCopyResult, agentSupports } from '@swarmy/core/protocol';
import type { ResticRepo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';

export interface WalgCopyRequest {
  /** Where it runs: the node the base backup ran on. */
  nodeId: string;
  from: ResticRepo;
  to: ResticRepo;
  /** The base backup just pushed (`base_…`), or `latest`. */
  backupName: string;
  resticNetwork?: string;
}

/** Copy one base backup and the WAL since it; what landed, and how far a restore from the copy reaches. Throws when it didn't. */
export async function walgCopy(ctx: OrgContext, req: WalgCopyRequest): Promise<{ snapshotId: string; sizeBytes?: string; restoresTo?: string }> {
  const build = ctx.hub.agentBuildFor?.(req.nodeId);
  if (!agentSupports(build?.capabilities, AGENT_CAPABILITY.dbWalgCopy)) {
    const which = build?.version ? `agent ${build.version}` : 'agent';
    throw new Error(`the ${which} on node ${req.nodeId} can't copy wal-g backups (it predates dbWalgCopy): update it, and the next base backup is copied`);
  }
  const raw = await ctx.hub.dispatch<unknown>(req.nodeId, 'db.walgCopy', {
    engine: 'wal-g',
    from: req.from,
    to: req.to,
    backupName: req.backupName,
    resticNetwork: req.resticNetwork,
  });
  const parsed = DbWalgCopyResult.safeParse(raw);
  if (!parsed.success) throw new Error('the agent answered the wal-g copy with something unreadable');
  const r = parsed.data;
  const size = r.backups.find((b) => b.name === r.backupName)?.sizeBytes;
  return {
    snapshotId: r.backupName,
    ...(size ? { sizeBytes: String(size) } : {}),
    ...(r.window ? { restoresTo: r.window.to } : {}),
  };
}
