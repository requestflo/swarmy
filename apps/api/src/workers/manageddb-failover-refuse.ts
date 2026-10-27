import { promotingMark, type StandbyCopy } from '@swarmy/core';
import type { OrgContext } from '@swarmy/trpc';

/**
 * A promotion the failover pass REFUSES because the shape is wrong for one
 * writer (@swarmy/core `planCopyPromotion` / `decideFailover` kind `refuse`):
 * two copies already write, a copy swarmy didn't promote writes, the copy it
 * began promoting is out of reach, a service stands for several copies. It
 * never promotes; it raises it once per reason per episode, loudly: a
 * critical `db-failover-confirm` alert, a `db.failover.refused` incident and
 * a `db.failover.refused` audit row. A person decides.
 */

type Seams = Pick<typeof import('@swarmy/trpc'), 'fireEvent' | 'recordIncidentEvent' | 'writeAudit'>;
interface RefuseContract {
  seams: Seams;
  ctx: OrgContext;
}

/** `${orgId}/${stack}/${cluster}` → the reason last raised (module memory, like confirmAlerted). */
const raised = new Map<string, string>();
/** → the standby copies seen writing beside a healthy writer last tick. */
const writingSeen = new Map<string, string>();

export async function refuseFailover(
  contract: RefuseContract,
  key: string,
  c: { stack: string; cluster: string },
  r: { reason: string; target?: string },
): Promise<void> {
  if (raised.get(key) === r.reason) return;
  raised.set(key, r.reason);
  const { seams, ctx } = contract;
  const ref = `${c.stack}/${c.cluster}`;
  const message = `${c.cluster}: swarmy won't promote a standby copy: ${r.reason}. Nothing was promoted. Check the copies on the stack's Data tab.`;
  await seams.fireEvent(ctx, { signal: 'db-failover-confirm', severity: 'critical', resource: `db:${ref}`, message }).catch(() => undefined);
  await seams
    .recordIncidentEvent(ctx, {
      groupKey: `db:${ref}`,
      kind: 'db.failover.refused',
      message,
      severity: 'critical',
      meta: { target: r.target ?? null, reason: r.reason, cluster: c.cluster, stack: c.stack },
    })
    .catch(() => undefined);
  await seams
    .writeAudit(ctx, { action: 'db.failover.refused', actorType: 'system', targetType: 'dbCluster', targetId: ref, metadata: { target: r.target ?? null, reason: r.reason } })
    .catch(() => undefined);
}

/** The shape is fine again: the next refusal is raised afresh. True when one was raised. */
export function clearRefusal(key: string): boolean {
  return raised.delete(key);
}

/**
 * While the writer is healthy: a standby copy that ALSO takes writes is two
 * writers, raised (never acted on). Otherwise a promoting mark left on a
 * standby whose copy is plainly still a standby is stale (the exec never
 * landed and the writer came back): it is dropped, so a later outage decides
 * afresh instead of resuming it.
 */
export async function guardStandbyWriters(
  contract: RefuseContract,
  key: string,
  c: { stack: string; cluster: string; writer: string; standbys: ReadonlyArray<{ name: string; labels: Record<string, string> }> },
  copies: readonly StandbyCopy[],
  dropMark: (service: string) => Promise<unknown>,
): Promise<void> {
  const writing = copies.filter((x) => x.inRecovery === false);
  if (writing.length > 0) {
    const who = writing.map((w) => `${w.service} on ${w.node ?? 'an unknown server'}`).join(', ');
    // Two ticks running: a demoted writer swarmy is already repointing is gone by then.
    if (writingSeen.get(key) !== who) return void writingSeen.set(key, who);
    return refuseFailover(contract, key, c, { target: writing[0]!.service, reason: `${who} takes writes while ${c.writer} is the writer (two writers)` });
  }
  writingSeen.delete(key);
  clearRefusal(key);
  const mark = promotingMark(c.standbys);
  if (mark && copies.some((x) => x.service === mark.service && x.node === mark.node && x.inRecovery === true)) await dropMark(mark.service);
}
