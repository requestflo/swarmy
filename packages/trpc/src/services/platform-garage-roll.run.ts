/**
 * The Garage rolling update as the engines step runs it (the rules are pure,
 * `platform-garage-roll.ts`). Resumable: what was dispatched lives in the
 * step's `data.garage`, so a controller restart re-enters the poll instead of
 * starting another update; a failure clears it, so a retry plans afresh.
 */
import type { PlatformManifest } from '@swarmy/core/platform-manifest';
import type { OrgContext } from '../context';
import { garageAdminAs } from './buckets.service';
import { garageMajorOf } from './garage-admin';
import {
  GARAGE_SERVICE,
  MEMBER_DELAY,
  garageRollTick,
  planGarageRoll,
  type GarageRollData,
} from './platform-garage-roll';
import { digestOf, serviceRollbackScript, serviceUpdateScript, type ManifestComponentLite, type StepContext, type StepOutcome } from './platform-upgrade.plan';
import { storageClusterRepo } from './storage-cluster.repo';

export interface GarageRollIO {
  live: () => { image: string; updateState?: string } | undefined;
  /** Running member tasks, and how many of them run `to` / `digest`. */
  tasks: (to: string, digest: string) => { running: number; onTarget: number };
  members: () => Promise<number>;
  health: (ref: string) => Promise<{ status: string; connected: number } | null>;
  resolve: (target: ManifestComponentLite) => Promise<string>;
  update: (to: string) => Promise<{ rc: number; state: string; output: string }>;
  rollback: () => Promise<{ rc: number; state: string }>;
  /** Record the BOM ref on the store, so a later redeploy keeps the version. */
  record: (ref: string) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

export async function rollGarage(c: StepContext, target: ManifestComponentLite | undefined, io: GarageRollIO, pollMs = 5_000): Promise<StepOutcome> {
  const d = (c.step.data ??= {}) as { garage?: GarageRollData };
  if (!d.garage) {
    const plan = planGarageRoll(io.live(), target);
    if (plan.action === 'skip') return { status: 'skipped', detail: plan.detail };
    const members = await io.members();
    const before = await io.health(plan.ref);
    if (before?.status !== 'healthy' || before.connected < members) {
      const state = before ? `${before.status}, ${before.connected}/${members} connected` : 'not answering';
      throw new Error(`object storage is not healthy (${state}) — it must be before its members restart one by one`);
    }
    const to = await io.resolve(target!);
    d.garage = { from: plan.from, to, ref: plan.ref, digest: plan.digest, dispatchedAt: new Date(io.now()).toISOString() };
    c.note(`object storage: rolling ${members} member(s) to ${plan.ref}, one at a time, healthy in between`);
    await c.checkpoint();
    const r = await io.update(to);
    if (r.rc !== 0) {
      d.garage = undefined;
      await c.checkpoint();
      throw new Error(`Swarm refused the object storage update: ${r.output.trim().split('\n').slice(-2).join(' ')}`);
    }
  }
  for (;;) {
    const g = d.garage!;
    const t = io.tasks(g.to, g.digest);
    const obs = { updateState: io.live()?.updateState, onTarget: t.onTarget, members: Math.max(await io.members(), t.running), health: await io.health(g.ref), now: io.now() };
    const { step, data } = garageRollTick(g, obs);
    d.garage = data;
    if (step.action === 'done') {
      await io.record(g.ref);
      return { status: 'done', detail: step.detail };
    }
    if (step.action === 'fail' || step.action === 'rollback') {
      const back = step.action === 'rollback' ? await io.rollback().catch(() => ({ rc: -1, state: 'error' })) : null;
      d.garage = undefined;
      await c.checkpoint();
      if (!back) throw new Error(step.reason);
      throw new Error(
        back.rc === 0
          ? `${step.reason}; every member was put back on the previous build`
          : `${step.reason}; putting the previous build back FAILED (Swarm: ${back.state}) — check ${GARAGE_SERVICE}`,
      );
    }
    if (c.step.detail !== step.detail) {
      c.step.detail = step.detail;
      await c.checkpoint();
    }
    await io.sleep(pollMs);
  }
}

/** The swarmy-side tools the real IO needs (passed in: they live in platform-upgrade.service). */
export interface GarageRollTools {
  dockerCli: (ctx: OrgContext, script: string, env: Record<string, string>, timeoutMs: number) => Promise<{ rc: number; state: string; output: string }>;
  registryLogin: (ctx: OrgContext) => Promise<{ host?: string; env: Record<string, string> }>;
  refResolver: (ctx: OrgContext, m: PlatformManifest) => Promise<(key: string, c: ManifestComponentLite) => string>;
}

export function garageRollIO(ctx: OrgContext, m: PlatformManifest, tools: GarageRollTools): GarageRollIO {
  const inv = () => ctx.hub.liveInventory(ctx.activeOrgId);
  return {
    live: () => {
      const s = inv().services.find((x) => x.name === GARAGE_SERVICE);
      return s ? { image: s.image, updateState: s.updateStatus } : undefined;
    },
    tasks: (to, digest) => {
      const running = inv().containers.filter(
        (c) => c.state === 'running' && (c.labels?.['com.docker.swarm.service.name'] === GARAGE_SERVICE || c.name.replace(/^\//, '').startsWith(`${GARAGE_SERVICE}.`)),
      );
      return { running: running.length, onTarget: running.filter((c) => c.image === to || digestOf(c.image) === digest).length };
    },
    members: async () => {
      const row = await storageClusterRepo.find(ctx, ctx.activeOrgId);
      return Array.isArray(row?.memberNodeIds) ? (row.memberNodeIds as string[]).length : 0;
    },
    health: async (ref) => {
      try {
        const h = JSON.parse(await garageAdminAs(ctx, garageMajorOf(ref), { method: 'GET', path: '/health' })) as { status?: string; connectedNodes?: number };
        return { status: h.status ?? 'unknown', connected: Number(h.connectedNodes ?? 0) };
      } catch {
        return null;
      }
    },
    resolve: async (target) => (await tools.refResolver(ctx, m))('garage', target),
    update: async (to) => {
      const reg = await tools.registryLogin(ctx);
      const script = serviceUpdateScript(GARAGE_SERVICE, to, { detach: true, login: reg.host, monitor: '30s', delay: MEMBER_DELAY, order: 'stop-first' });
      return tools.dockerCli(ctx, script, reg.env, 3 * 60_000);
    },
    rollback: () => tools.dockerCli(ctx, serviceRollbackScript(GARAGE_SERVICE), {}, 15 * 60_000),
    record: async (ref) => void (await storageClusterRepo.update(ctx, ctx.activeOrgId, { engineImage: ref })),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
  };
}
