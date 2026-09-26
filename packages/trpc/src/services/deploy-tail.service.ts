/**
 * The controller-owned tail of a traced deploy: after the services went out,
 * follow the route's certificate and the health check (./deploy-health, the
 * pure fold) every 2 s for up to 10 min, then close the trace. Best-effort
 * and fire-and-forget: the deploy already answered; a failed read skips a
 * beat; nothing here throws.
 */
import { buildInventory } from '@swarmy/core';
import type { OrgContext } from '../context';
import { listDomains } from './ingress.service';
import { nextHealthEvents, type HealthMemo, type HealthSnapshot } from './deploy-health';
import type { DeployTrace } from './deploy-trace.service';

const TICK_MS = 2_000;
const MAX_MS = 10 * 60_000;

async function snapshot(ctx: OrgContext, stack: string, expect: string[]): Promise<HealthSnapshot> {
  const { services, containers } = ctx.hub.liveInventory(ctx.activeOrgId);
  const live = buildInventory(services, containers).services.filter((s) => s.stack === stack);
  const domains = await listDomains(ctx, stack).catch(() => []);
  const d = domains.find((x) => !x.auto) ?? domains[0] ?? null;
  return {
    services: live.map((s) => ({ name: s.name, running: s.replicas.running, desired: s.replicas.desired })),
    allVisible: expect.every((n) => live.some((s) => s.name === n)),
    domain: d
      ? {
          host: d.host,
          tls: d.tls,
          serving: d.serving,
          state: d.status?.state ?? null,
          certIssuer: d.status?.certificate?.issuer ?? null,
          certError: d.status?.certificate?.error ?? null,
        }
      : null,
  };
}

/** Follow route + health for `trace` until live or the bound; then finish it. */
export function followDeployTail(
  ctx: OrgContext,
  trace: DeployTrace,
  services: string[],
  opts: { tickMs?: number; maxMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const tick = opts.tickMs ?? TICK_MS;
  const max = opts.maxMs ?? MAX_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const run = async (): Promise<void> => {
    let memo: HealthMemo = { route: null, health: null };
    for (let waited = 0; waited <= max; waited += tick) {
      const snap = await snapshot(ctx, trace.stack, services).catch(() => null);
      if (snap) {
        const out = nextHealthEvents(memo, snap);
        memo = out.memo;
        for (const e of out.events) {
          trace.emit({ stage: e.stage, status: e.status, message: e.message, ...(e.host ? { detail: { host: e.host } } : {}) });
        }
        if (out.live) return;
      }
      await sleep(tick);
    }
  };
  return run()
    .catch(() => undefined)
    .finally(() => trace.finish());
}
