import { PG_PASSWORD_FROM_MEMBER, type DbSwitchoverRunView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected } from '../errors';
import { execInService } from './resilience.service';
import { runDbSwitchover, type SwitchoverIo } from './manageddb-switchover.run';
import { switchoverRunFor } from './manageddb-switchover.runs';
import { planDbSwitchover } from './manageddb-switchover.service';

/**
 * `db.switchover` / `db.switchoverRun`: plan as the caller (a refusal is the
 * mutation's error, before anything is touched), then run in the background
 * and answer with the run's first view; the dashboard polls the relay for the
 * rest. The run keeps the caller's context, so its audit rows name them.
 */

/** psql inside a member's running task, as the boot layer's superuser (the password file never leaves it). */
export function pgSwitchoverIo(ctx: OrgContext): SwitchoverIo {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    psql: (service, sql) => execInService(ctx, service, `${PG_PASSWORD_FROM_MEMBER} psql -U postgres -h 127.0.0.1 -p 5432 -tAc "${sql}"`),
  };
}

export async function startDbSwitchover(
  ctx: OrgContext,
  input: { stack: string; cluster: string; target?: string },
  io: SwitchoverIo = pgSwitchoverIo(ctx),
): Promise<DbSwitchoverRunView> {
  const { plan } = await planDbSwitchover(ctx, input);
  if (!plan.ok) throw commandRejected(plan.reason);
  return new Promise<DbSwitchoverRunView>((resolve, reject) => {
    // Rejects only before the run began; later aborts land on the run view.
    runDbSwitchover(ctx, input, io, { plan, onStart: resolve }).catch(reject);
  });
}

export function getDbSwitchoverRun(ctx: OrgContext, input: { stack: string; cluster: string }): DbSwitchoverRunView | null {
  return switchoverRunFor(ctx.activeOrgId, input.stack, input.cluster);
}
