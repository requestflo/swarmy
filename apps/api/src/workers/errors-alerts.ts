/**
 * Error-tracking spike sweep (epic-developer-platform §6).
 *
 * Every minute, for every org whose observability store is on and that has
 * at least one error project, compare each issue's last-10-minute event
 * count with its previous-24-hour rate and raise / resolve `error-spike`
 * through the alerts spine (`sweepErrorSpikes` → `fireEvent`). New-issue and
 * regression alerts fire inline at ingest; this worker only owns spikes.
 * Observe-only: it never deletes events (ClickHouse TTL owns retention).
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { sweepErrorSpikes, systemContext } from '@swarmy/trpc';
import { hub } from '../gateway';

const TICK_MS = 60_000;

async function tick(): Promise<void> {
  const orgs = await prisma.errorProject
    .findMany({ distinct: ['orgId'], select: { orgId: true } })
    .catch(() => [] as { orgId: string }[]);
  for (const { orgId } of orgs) {
    const ctx = systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId);
    await sweepErrorSpikes(ctx).catch(() => undefined);
  }
}

export function startErrorsAlerts(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    tick()
      .catch(() => undefined)
      .finally(() => {
        running = false;
      });
  }, TICK_MS);
  return () => clearInterval(timer);
}
