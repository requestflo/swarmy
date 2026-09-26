import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { runWeeklySummary, systemContext, type OrgContext, type WeeklyRunOutcome } from '@swarmy/trpc';
import { hub } from '../gateway';

/**
 * Weekly cost summary (owner decision Q6). A scheduler only: every 10 min it
 * asks each org with the summary switched on whether its Monday 09:00 slot
 * (the workspace's quiet-hours time zone, else UTC) is due, and lets
 * `runWeeklySummary` (@swarmy/trpc cost-budget.service) claim the slot via
 * `lastWeeklyAt` and send ONE plain message through the chosen alert channels.
 * The claim is a conditional update, so overlapping ticks, a restart or a
 * second controller never double-send; a steady state sends nothing.
 *
 * Org source is DB-gated (`costBudget.weeklySummary`), not node-gated: the
 * summary is about money, not live Docker state. The first tick waits 60 s so
 * the hub has reconnected nodes (the run rate reads their price labels).
 */

const TICK_MS = 10 * 60_000;
const FIRST_RUN_MS = 60_000;

export interface WeeklyTickDeps {
  orgIds: () => Promise<string[]>;
  context: (orgId: string) => OrgContext;
  run: (ctx: OrgContext, now: Date) => Promise<WeeklyRunOutcome>;
}

const defaultDeps: WeeklyTickDeps = {
  orgIds: async () =>
    (await prisma.costBudget.findMany({ where: { weeklySummary: true }, select: { orgId: true } })).map((r) => r.orgId),
  context: (orgId) => systemContext({ db: prisma, hub, auth: authRegistry.getAuth() }, orgId),
  run: (ctx, now) => runWeeklySummary(ctx, now),
};

/** One tick over every org with the summary on; one org's failure never stops the rest. */
export async function weeklySummaryTick(now: Date, deps: WeeklyTickDeps = defaultDeps): Promise<Record<string, WeeklyRunOutcome | 'error'>> {
  const out: Record<string, WeeklyRunOutcome | 'error'> = {};
  for (const orgId of await deps.orgIds()) {
    out[orgId] = await deps.run(deps.context(orgId), now).catch(() => 'error' as const);
  }
  return out;
}

export function startCostWeeklySummary(): () => void {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await weeklySummaryTick(new Date());
    } catch {
      // DB unavailable this tick — try again next time.
    } finally {
      running = false;
    }
  };
  const kickoff = setTimeout(() => void tick(), FIRST_RUN_MS);
  const timer = setInterval(() => void tick(), TICK_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
