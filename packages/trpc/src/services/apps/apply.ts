/**
 * The git-apps plan EXECUTOR: runs a plan's runnable actions in phase order
 * against an `AppOps` port (the real one is wired to the existing services in
 * apps.service.ts; tests pass a fake). No IO of its own.
 *
 * Rules:
 *   - Only `auto` actions and `confirm` actions whose id is in `confirmed`
 *     run; everything else is `held`. A `blocked` plan never reaches here.
 *   - Services deploy as ONE compose (docker stack deploy semantics, the
 *     admission spine, a Release row, the health gate): changed services get
 *     their new spec + image; a held service keeps its last-applied spec and
 *     running image, so holding one change never drags another along.
 *   - A service with a `release:` command: on update the release runs in the
 *     NEW image before the rollout (failure aborts the deploy); on first
 *     deploy the service starts at 0 replicas, gets wired, runs the release,
 *     then scales up.
 *   - The first failure stops every later phase (they may depend on it);
 *     the ledger records exactly what succeeded, so the next plan resumes.
 */
import type {
  DesiredApp,
  DesiredJob,
  DesiredResource,
  DesiredRoute,
  DesiredService,
  Plan,
  PlanAction,
  ResourceType,
} from '@swarmy/app-config';
import { attachmentKey, attachmentLive, compileServices, type Attachment } from './compile';
import { ledgerAfter, type AppLedger } from './live';

export interface AppOps {
  createResource(r: DesiredResource, d: DesiredApp): Promise<{ bucketId?: string }>;
  updateResource(
    r: DesiredResource,
    before: DesiredResource | undefined,
    d: DesiredApp,
  ): Promise<void>;
  deleteResource(
    name: string,
    type: ResourceType,
    before: AppLedger['resources'][string] | undefined,
  ): Promise<void>;
  build(action: Extract<PlanAction, { kind: 'build' }>): Promise<{ image: string }>;
  deploy(composeSource: string): Promise<void>;
  attach(a: Attachment, ledger: AppLedger): Promise<void>;
  runRelease(service: string, image: string, command: string[]): Promise<void>;
  setRoutes(service: string, routes: DesiredRoute[]): Promise<void>;
  upsertJob(job: DesiredJob, existingId: string | undefined): Promise<{ jobId: string }>;
  removeJob(jobId: string): Promise<void>;
  link(peer: string): Promise<void>;
  unlink(peer: string): Promise<void>;
  removeService(name: string): Promise<void>;
  /** The image a live app service runs now (for services this plan does not rebuild). */
  liveImage(service: string): string | undefined;
  /** The live env (`KEY=value`) of an app service, if it is in the inventory. */
  liveEnv?(service: string): string[] | undefined;
}

export type ActionOutcome = { status: 'done' | 'held' | 'failed' | 'skipped'; message?: string };

export interface ApplyResult {
  ledger: AppLedger;
  outcomes: Record<string, ActionOutcome>;
  status: 'applied' | 'needs-confirmation' | 'failed';
  error?: string;
  warnings: string[];
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function applyPlan(input: {
  plan: Plan;
  desired: DesiredApp;
  ledger: AppLedger;
  ops: AppOps;
  confirmed?: string[];
  commit?: string;
}): Promise<ApplyResult> {
  const { plan, desired, ops } = input;
  const confirmed = new Set(input.confirmed ?? []);
  let ledger = input.ledger;
  const outcomes: Record<string, ActionOutcome> = {};
  const warnings: string[] = [];
  const runnable = (a: PlanAction) =>
    a.gate === 'auto' || (a.gate === 'confirm' && confirmed.has(a.id));
  for (const a of plan.actions)
    if (!runnable(a)) outcomes[a.id] = { status: 'held', message: a.reason };
  let failed: string | undefined;

  const run = async (
    a: PlanAction,
    fn: () => Promise<Parameters<typeof ledgerAfter>[3] | void>,
  ) => {
    if (failed || !runnable(a)) {
      if (failed && runnable(a))
        outcomes[a.id] = { status: 'skipped', message: 'an earlier step failed' };
      return false;
    }
    try {
      const r = await fn();
      ledger = ledgerAfter(ledger, desired, a, r ?? {});
      outcomes[a.id] = { status: 'done' };
      return true;
    } catch (e) {
      failed = `${a.reason}: ${msg(e)}`;
      outcomes[a.id] = { status: 'failed', message: msg(e) };
      return false;
    }
  };
  const byKind = <K extends PlanAction['kind']>(k: K) =>
    plan.actions.filter((a): a is Extract<PlanAction, { kind: K }> => a.kind === k);

  // ── 1 resources ──
  for (const a of plan.actions) {
    if (a.kind === 'resource.create') await run(a, () => ops.createResource(a.resource, desired));
    else if (a.kind === 'resource.update')
      await run(a, async () => ops.updateResource(a.resource, ledger.resources[a.name], desired));
  }

  // ── 2 builds ──
  const built: Record<string, string> = {}; // buildKey → digest image
  for (const a of byKind('build')) {
    await run(a, async () => {
      const { image } = await ops.build(a);
      built[a.key] = image;
    });
  }

  // ── 3 one compose deploy ──
  const deploys = byKind('service.deploy');
  const deployNow = deploys.filter((a) => runnable(a));
  if (!failed && deployNow.length) {
    const nowNames = new Set(deployNow.map((a) => a.name));
    // Held services keep their last-applied spec; brand-new held ones stay out.
    const services: DesiredService[] = [];
    const images: Record<string, string> = {};
    for (const s of desired.services) {
      const action = deploys.find((a) => a.name === s.name);
      if (action && !nowNames.has(s.name)) {
        const prev = ledger.services[s.name];
        if (!prev?.applied) continue;
        services.push(prev.applied);
        images[s.name] = ops.liveImage(s.name) ?? prev.image;
        continue;
      }
      services.push(s);
      const act = deployNow.find((a) => a.name === s.name);
      const img = act
        ? 'fromBuild' in act.image
          ? built[act.image.fromBuild]
          : act.image.image
        : (ops.liveImage(s.name) ??
          ledger.services[s.name]?.image ??
          (s.source.kind === 'image' ? s.source.image : undefined));
      if (img) images[s.name] = img;
    }
    const d2: DesiredApp = { ...desired, services };
    const firstWithRelease = deployNow
      .filter((a) => a.op === 'create' && a.service.release?.length)
      .map((a) => a.name);
    const compiled = compileServices(d2, images, {
      commit: input.commit,
      replicasOverride: Object.fromEntries(firstWithRelease.map((n) => [n, 0])),
    });
    const blocking = compiled.issues.filter((i) => i.severity === 'error');
    warnings.push(...compiled.issues.filter((i) => i.severity === 'warning').map((i) => i.message));
    const deployStep = async () => {
      if (blocking.length)
        throw new Error(blocking.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
      // Update releases run in the NEW image before the rollout.
      for (const a of deployNow) {
        if (a.op === 'update' && a.service.release?.length)
          await ops.runRelease(a.name, images[a.name]!, a.service.release);
      }
      await ops.deploy(compiled.composeSource);
      // Wire credentials the compose must never carry (once per service/resource/var).
      for (const att of compiled.attachments) {
        const key = attachmentKey(att);
        // The ledger says attached, but only live proves it: re-attach when the
        // service's env shows it's gone (QA-055).
        const inLedger = ledger.attached[att.service]?.includes(key);
        if (inLedger && attachmentLive(att, ops.liveEnv?.(att.service)) !== false) continue;
        await ops.attach(att, ledger);
        ledger = {
          ...ledger,
          attached: {
            ...ledger.attached,
            [att.service]: [...new Set([...(ledger.attached[att.service] ?? []), key])],
          },
        };
      }
      if (firstWithRelease.length) {
        for (const n of firstWithRelease) {
          const s = services.find((x) => x.name === n)!;
          await ops.runRelease(n, images[n]!, s.release!);
        }
        await ops.deploy(compileServices(d2, images, { commit: input.commit }).composeSource);
      }
    };
    try {
      await deployStep();
      for (const a of deployNow) {
        ledger = ledgerAfter(ledger, desired, a, { image: images[a.name] });
        outcomes[a.id] = { status: 'done' };
      }
    } catch (e) {
      failed = `deploy ${[...nowNames].join(', ')}: ${msg(e)}`;
      for (const a of deployNow) outcomes[a.id] = { status: 'failed', message: msg(e) };
    }
  }

  // ── 4 routes (whole route set per touched service), jobs, links ──
  const routeActs = plan.actions.filter(
    (a): a is Extract<PlanAction, { kind: 'route.add' | 'route.update' | 'route.remove' }> =>
      a.kind === 'route.add' || a.kind === 'route.update' || a.kind === 'route.remove',
  );
  const touched = new Map<string, typeof routeActs>();
  for (const a of routeActs) {
    const svc =
      a.kind === 'route.remove'
        ? ledger.routes[a.path === '/' ? a.host : `${a.host}${a.path}`]?.service
        : a.route.service;
    if (!svc) continue;
    touched.set(svc, [...(touched.get(svc) ?? []), a]);
  }
  for (const [svc, acts] of touched) {
    if (failed || acts.some((a) => !runnable(a))) {
      for (const a of acts)
        if (runnable(a))
          outcomes[a.id] = {
            status: failed ? 'skipped' : 'held',
            message: failed ? 'an earlier step failed' : 'waits with its sibling routes',
          };
      continue;
    }
    const stillExists = desired.services.some((s) => s.name === svc);
    try {
      if (stillExists)
        await ops.setRoutes(
          svc,
          desired.routes.filter((r) => r.service === svc),
        );
      for (const a of acts) {
        ledger = ledgerAfter(ledger, desired, a);
        outcomes[a.id] = { status: 'done' };
      }
    } catch (e) {
      failed = `routes for ${svc}: ${msg(e)}`;
      for (const a of acts) outcomes[a.id] = { status: 'failed', message: msg(e) };
    }
  }
  for (const a of plan.actions) {
    if (a.kind === 'job.create' || a.kind === 'job.update') {
      await run(a, () => ops.upsertJob(a.job, ledger.jobs[a.name]?.jobId));
    } else if (a.kind === 'link.add') {
      await run(a, () => ops.link(a.peer));
    }
  }

  // ── 5 removals ──
  for (const a of plan.actions) {
    if (a.kind === 'job.remove') {
      const id = ledger.jobs[a.name]?.jobId;
      await run(a, async () => (id ? ops.removeJob(id) : undefined));
    } else if (a.kind === 'link.remove') await run(a, () => ops.unlink(a.peer));
    else if (a.kind === 'service.remove') await run(a, () => ops.removeService(a.name));
  }

  // ── 6 data deletes (only ever confirmed) ──
  for (const a of byKind('resource.delete')) {
    await run(a, () => ops.deleteResource(a.name, a.resourceType, ledger.resources[a.name]));
  }

  for (const a of plan.actions)
    outcomes[a.id] ??= {
      status: 'skipped',
      message: failed ? 'an earlier step failed' : 'nothing to do',
    };
  const held = Object.values(outcomes).some((o) => o.status === 'held');
  return {
    ledger,
    outcomes,
    status: failed ? 'failed' : held ? 'needs-confirmation' : 'applied',
    ...(failed ? { error: failed } : {}),
    warnings,
  };
}
