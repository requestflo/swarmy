/**
 * The planner: `DesiredApp` × `LiveApp` → an ordered, gated action plan.
 *
 * Pure (no IO). The controller builds `LiveApp` from Docker truth — each unit
 * it applied carries a `swarmy.app.sig` label (and the last-applied unit JSON
 * for field-level diffs) — and executes the plan's `auto` actions in phase
 * order. `confirm` actions are held for a human in the dashboard; any
 * `blocked` action makes the whole plan `blocked` (nothing applies, the commit
 * check fails with the reason).
 *
 * Phases (lower first; removals always last, data deletes very last):
 *   1 resource.create / resource.update   (data exists before anything binds it)
 *   2 build                               (one per distinct build input set)
 *   3 service.deploy                      (by digest — built or pinned image)
 *   4 route.add / route.update / job.create / job.update
 *   5 route.remove / job.remove / service.remove
 *   6 resource.delete                     (always `confirm`)
 */
import type {
  BuildSource,
  DesiredApp,
  DesiredJob,
  DesiredResource,
  DesiredRoute,
  DesiredService,
} from './desired';
import type { ResourceType } from './schema';
import { POSTGRES_HA } from './schema';

// ── live snapshot (what the controller reads off Docker labels) ─────────────

export interface LiveService {
  name: string;
  /** The running image, digest-pinned (`host/app@sha256:…`). */
  image: string;
  sig?: string;
  /** Build key the running image was built from (`swarmy.app.build` label). */
  buildKey?: string;
  /** Named volume keys mounted today. */
  volumes: string[];
  applied?: DesiredService;
}
export interface LiveResource {
  name: string;
  type: ResourceType;
  sig?: string;
  applied?: DesiredResource;
}
export interface LiveRoute {
  host: string;
  path: string;
  service: string;
  sig?: string;
}
export interface LiveJob {
  name: string;
  sig?: string;
}
export interface LiveApp {
  stack: string;
  services: LiveService[];
  resources: LiveResource[];
  routes: LiveRoute[];
  jobs: LiveJob[];
  /** Peer apps this stack is linked to today. */
  connect: string[];
}

export const emptyLive = (stack: string): LiveApp => ({
  stack,
  services: [],
  resources: [],
  routes: [],
  jobs: [],
  connect: [],
});

// ── plan ─────────────────────────────────────────────────────────────────────

export type Gate = 'auto' | 'confirm' | 'blocked';

export interface FieldChange {
  path: string;
  from?: unknown;
  to?: unknown;
}

interface ActionBase {
  /** Stable id, e.g. `resource.update:db` — the dashboard confirms by id. */
  id: string;
  phase: 1 | 2 | 3 | 4 | 5 | 6;
  gate: Gate;
  /** Plain words for the PR comment / dashboard. */
  reason: string;
}

export type PlanAction = ActionBase &
  (
    | { kind: 'resource.create'; name: string; resource: DesiredResource }
    | { kind: 'resource.update'; name: string; resource: DesiredResource; changes: FieldChange[] }
    | { kind: 'resource.delete'; name: string; resourceType: ResourceType }
    | ({ kind: 'build'; services: string[] } & Omit<BuildSource, 'kind'>)
    | {
        kind: 'service.deploy';
        name: string;
        op: 'create' | 'update';
        image: { fromBuild: string } | { image: string };
        changes: FieldChange[];
        service: DesiredService;
      }
    | { kind: 'service.remove'; name: string }
    | { kind: 'route.add' | 'route.update'; host: string; path: string; route: DesiredRoute }
    | { kind: 'route.remove'; host: string; path: string }
    | { kind: 'job.create' | 'job.update'; name: string; job: DesiredJob }
    | { kind: 'job.remove'; name: string }
    | { kind: 'link.add' | 'link.remove'; peer: string }
  );

export type PlanStatus = 'noop' | 'ready' | 'needs-confirmation' | 'blocked';

export interface Plan {
  stack: string;
  status: PlanStatus;
  actions: PlanAction[];
  counts: Record<Gate, number>;
}

export interface PlanOptions {
  /**
   * Repo paths the triggering commit(s) changed. When given, a build whose
   * watch paths saw no change — and whose inputs match what is running — is
   * skipped and the running digest reused (monorepo: only rebuild what moved).
   * Omitted = unknown = build everything built from source.
   */
  changedPaths?: string[];
  /**
   * The app's "require approval" toggle: every change waits for a human in the
   * dashboard (not only the destructive ones). Blocked stays blocked.
   */
  requireApproval?: boolean;
}

export function planApp(desired: DesiredApp, live: LiveApp, opts: PlanOptions = {}): Plan {
  const actions: PlanAction[] = [];
  const liveSvc = new Map(live.services.map((s) => [s.name, s]));
  const liveRes = new Map(live.resources.map((r) => [r.name, r]));
  const liveRoute = new Map(live.routes.map((r) => [routeKey(r), r]));
  const liveJob = new Map(live.jobs.map((j) => [j.name, j]));

  // ── 1 resources (postgres before vector: pgvector installs onto it) ──
  const resOrder = [...desired.resources].sort(
    (a, b) => typeRank(a.type) - typeRank(b.type) || (a.name < b.name ? -1 : 1),
  );
  for (const r of resOrder) {
    const l = liveRes.get(r.name);
    if (!l) {
      actions.push({
        id: `resource.create:${r.name}`,
        phase: 1,
        gate: 'auto',
        reason: `create ${describeResource(r)}${r.type === 'postgres' && desired.previewData ? ` — a COPY of ${desired.previewData.fromEnvironment}'s latest backup${desired.previewData.scrub ? `, scrubbed by ${desired.previewData.scrub}` : ''}; destroyed with the preview` : ''}`,
        kind: 'resource.create',
        name: r.name,
        resource: r,
      });
      continue;
    }
    if (l.type !== r.type) {
      // Same name, new type: the old one must go (confirmed) before the new one exists.
      actions.push({
        id: `resource.delete:${r.name}`,
        phase: 6,
        gate: 'confirm',
        reason: `${l.type} "${r.name}" is being replaced by a ${r.type} — its data will be deleted`,
        kind: 'resource.delete',
        name: r.name,
        resourceType: l.type,
      });
      actions.push({
        id: `resource.create:${r.name}`,
        phase: 1,
        gate: 'confirm',
        reason: `create ${describeResource(r)} (replaces a ${l.type})`,
        kind: 'resource.create',
        name: r.name,
        resource: r,
      });
      continue;
    }
    if (l.sig === r.sig) continue;
    const changes = l.applied ? diffFields(l.applied, r) : [];
    const { gate, reason } = gateResourceUpdate(l.applied, r);
    actions.push({
      id: `resource.update:${r.name}`,
      phase: 1,
      gate,
      reason,
      kind: 'resource.update',
      name: r.name,
      resource: r,
      changes,
    });
  }

  // ── 2 builds ──
  const buildsByKey = new Map<string, { source: BuildSource; services: DesiredService[] }>();
  for (const s of desired.services) {
    if (s.source.kind !== 'build') continue;
    const e = buildsByKey.get(s.source.key) ?? { source: s.source, services: [] };
    e.services.push(s);
    buildsByKey.set(s.source.key, e);
  }
  const building = new Set<string>();
  // swarmy.yaml itself never triggers a rebuild — it is config, not image input.
  const changed = opts.changedPaths?.filter((p) => !CONFIG_FILES.has(p));
  for (const [key, { source, services }] of buildsByKey) {
    const reasons: string[] = [];
    for (const s of services) {
      const l = liveSvc.get(s.name);
      if (!l) reasons.push(`${s.name} is new`);
      else if (l.buildKey !== key) reasons.push(`${s.name}'s build settings changed`);
    }
    if (changed === undefined) reasons.push('new commit');
    else if (touches(changed, source.watch))
      reasons.push(`files changed under ${source.watch.join(', ')}`);
    if (!reasons.length) continue;
    building.add(key);
    const { kind: _k, ...inputs } = source;
    actions.push({
      id: `build:${key}`,
      phase: 2,
      gate: 'auto',
      reason: `build ${source.context === '.' ? 'the repo root' : source.context} (${unique(reasons).join('; ')})`,
      kind: 'build',
      services: services.map((s) => s.name),
      ...inputs,
    });
  }

  // ── 3 service deploys ──
  for (const s of desired.services) {
    const l = liveSvc.get(s.name);
    const rebuilt = s.source.kind === 'build' && building.has(s.source.key);
    if (l && l.sig === s.sig && !rebuilt) continue;
    const image: { fromBuild: string } | { image: string } =
      s.source.kind === 'image'
        ? { image: s.source.image }
        : rebuilt || !l
          ? { fromBuild: s.source.key }
          : { image: l.image };
    const droppedVolumes = l ? l.volumes.filter((v) => !s.volumes.some((d) => d.name === v)) : [];
    const changes = l?.applied ? diffFields(l.applied, s) : [];
    const gate: Gate = droppedVolumes.length ? 'confirm' : 'auto';
    const reason = !l
      ? `deploy new service ${s.name}`
      : droppedVolumes.length
        ? `${s.name} stops mounting volume ${droppedVolumes.join(', ')} — its data would be orphaned`
        : rebuilt && l.sig === s.sig
          ? `roll ${s.name} to the new build`
          : `update ${s.name}${changes.length ? ` (${changes.map((c) => c.path).join(', ')})` : ''}`;
    actions.push({
      id: `service.deploy:${s.name}`,
      phase: 3,
      gate,
      reason,
      kind: 'service.deploy',
      name: s.name,
      op: l ? 'update' : 'create',
      image,
      changes,
      service: s,
    });
  }

  // ── 4 routes + jobs (upserts) ──
  for (const r of desired.routes) {
    const l = liveRoute.get(routeKey(r));
    if (!l) {
      actions.push({
        id: `route.add:${routeKey(r)}`,
        phase: 4,
        gate: 'auto',
        reason: `route ${routeKey(r)} → ${r.service}:${r.port}`,
        kind: 'route.add',
        host: r.host,
        path: r.path,
        route: r,
      });
    } else if (l.sig !== r.sig) {
      actions.push({
        id: `route.update:${routeKey(r)}`,
        phase: 4,
        gate: 'auto',
        reason: `update route ${routeKey(r)}`,
        kind: 'route.update',
        host: r.host,
        path: r.path,
        route: r,
      });
    }
  }
  for (const j of desired.jobs) {
    const l = liveJob.get(j.name);
    if (!l)
      actions.push({
        id: `job.create:${j.name}`,
        phase: 4,
        gate: 'auto',
        reason: `schedule ${j.name} (${j.schedule})`,
        kind: 'job.create',
        name: j.name,
        job: j,
      });
    else if (l.sig !== j.sig)
      actions.push({
        id: `job.update:${j.name}`,
        phase: 4,
        gate: 'auto',
        reason: `update job ${j.name}`,
        kind: 'job.update',
        name: j.name,
        job: j,
      });
  }

  const liveLinks = new Set(live.connect);
  for (const peer of desired.connect) {
    if (!liveLinks.has(peer))
      actions.push({
        id: `link.add:${peer}`,
        phase: 4,
        gate: 'auto',
        reason: `connect to app ${peer}`,
        kind: 'link.add',
        peer,
      });
  }

  // ── 5 removals (routes first so nothing routes to a removed service) ──
  const desiredRoutes = new Set(desired.routes.map(routeKey));
  for (const l of live.routes) {
    if (desiredRoutes.has(routeKey(l))) continue;
    actions.push({
      id: `route.remove:${routeKey(l)}`,
      phase: 5,
      gate: 'auto',
      reason: `stop routing ${routeKey(l)}`,
      kind: 'route.remove',
      host: l.host,
      path: l.path,
    });
  }
  const desiredJobs = new Set(desired.jobs.map((j) => j.name));
  for (const l of live.jobs) {
    if (desiredJobs.has(l.name)) continue;
    actions.push({
      id: `job.remove:${l.name}`,
      phase: 5,
      gate: 'auto',
      reason: `unschedule ${l.name}`,
      kind: 'job.remove',
      name: l.name,
    });
  }
  const desiredLinks = new Set(desired.connect);
  for (const peer of live.connect) {
    if (!desiredLinks.has(peer))
      actions.push({
        id: `link.remove:${peer}`,
        phase: 5,
        gate: 'auto',
        reason: `disconnect from app ${peer}`,
        kind: 'link.remove',
        peer,
      });
  }
  const desiredSvcs = new Set(desired.services.map((s) => s.name));
  for (const l of live.services) {
    if (desiredSvcs.has(l.name)) continue;
    const gate: Gate = l.volumes.length ? 'confirm' : 'auto';
    const reason = l.volumes.length
      ? `remove ${l.name} — it mounts volume ${l.volumes.join(', ')}, which would be orphaned`
      : `remove service ${l.name}`;
    actions.push({
      id: `service.remove:${l.name}`,
      phase: 5,
      gate,
      reason,
      kind: 'service.remove',
      name: l.name,
    });
  }

  // ── 6 resource deletes — never automatic ──
  const desiredRes = new Set(desired.resources.map((r) => r.name));
  for (const l of live.resources) {
    if (desiredRes.has(l.name)) continue;
    actions.push({
      id: `resource.delete:${l.name}`,
      phase: 6,
      gate: 'confirm',
      reason:
        l.type === 'postgres'
          ? `remove postgres "${l.name}" — its data volume is kept until you delete it permanently`
          : `delete ${l.type} "${l.name}" and all of its data`,
      kind: 'resource.delete',
      name: l.name,
      resourceType: l.type,
    });
  }

  actions.sort((a, b) => a.phase - b.phase || kindRank(a.kind) - kindRank(b.kind));
  if (opts.requireApproval) for (const a of actions) if (a.gate === 'auto') a.gate = 'confirm';
  const counts: Record<Gate, number> = { auto: 0, confirm: 0, blocked: 0 };
  for (const a of actions) counts[a.gate] += 1;
  const status: PlanStatus = counts.blocked
    ? 'blocked'
    : counts.confirm
      ? 'needs-confirmation'
      : actions.length
        ? 'ready'
        : 'noop';
  return { stack: desired.stack, status, actions, counts };
}

// ── gating rules for in-place resource changes ──────────────────────────────

const CONFIG_FILES = new Set(['swarmy.yaml', 'swarmy.yml']);

const haRank = (ha: string): number => (POSTGRES_HA as readonly string[]).indexOf(ha);

/**
 * Decide whether an in-place resource change may apply on its own. The rule:
 * anything that can lose data, reduce durability, or widen exposure needs a
 * human; anything impossible is blocked; everything else is automatic.
 */
export function gateResourceUpdate(
  before: DesiredResource | undefined,
  after: DesiredResource,
): { gate: Gate; reason: string } {
  if (!before) {
    return {
      gate: 'confirm',
      reason: `${after.type} "${after.name}" exists but was not created from swarmy.yaml — review before swarmy takes it over`,
    };
  }
  const confirm: string[] = [];
  const auto: string[] = [];
  if (before.type === 'postgres' && after.type === 'postgres') {
    if (after.version < before.version) {
      return {
        gate: 'blocked',
        reason: `postgres "${after.name}" cannot go from ${before.version} down to ${after.version}`,
      };
    }
    if (after.version > before.version)
      confirm.push(
        `upgrade postgres ${before.version} → ${after.version} (dump + restore, brief write downtime)`,
      );
    if (haRank(after.ha) < haRank(before.ha)) confirm.push(`reduce HA ${before.ha} → ${after.ha}`);
    else if (after.ha !== before.ha) auto.push(`HA ${before.ha} → ${after.ha}`);
    if (after.database !== before.database)
      confirm.push(`switch to database "${after.database}" (the app will see an empty database)`);
    if (before.backups && !after.backups) confirm.push('turn backups off');
    if (after.replicas !== before.replicas)
      auto.push(`replicas ${before.replicas} → ${after.replicas}`);
    if (JSON.stringify(after.backups) !== JSON.stringify(before.backups) && after.backups)
      auto.push('backup schedule');
  } else if (before.type === 'cache' && after.type === 'cache') {
    if ((after.purpose ?? 'cache') !== (before.purpose ?? 'cache'))
      confirm.push(
        `switch ${before.purpose ?? 'cache'} → ${after.purpose ?? 'cache'} (queues never evict; caches do) — declare a new resource instead`,
      );
    if (after.engine !== before.engine)
      confirm.push(`switch ${before.engine} → ${after.engine} (cache starts empty)`);
    if (after.memoryMb < before.memoryMb)
      confirm.push(
        `shrink memory ${before.memoryMb}MB → ${after.memoryMb}MB (keys will be evicted)`,
      );
    else if (after.memoryMb !== before.memoryMb)
      auto.push(`memory ${before.memoryMb}MB → ${after.memoryMb}MB`);
    if (after.ha !== before.ha || after.replicas !== before.replicas)
      auto.push(`topology ${after.ha}×${after.replicas}`);
  } else if (before.type === 'search' && after.type === 'search') {
    if (after.engine !== before.engine)
      confirm.push(`switch ${before.engine} → ${after.engine} (indexes start empty)`);
  } else if (before.type === 'vector' && after.type === 'vector') {
    if (after.engine !== before.engine || after.on !== before.on)
      confirm.push('move the vector store (collections start empty)');
  } else if (before.type === 'bucket' && after.type === 'bucket') {
    if (after.access === 'public' && before.access !== 'public')
      confirm.push('make the bucket PUBLIC (world-readable)');
    else if (after.access !== before.access) auto.push(`access ${before.access} → ${after.access}`);
    if (
      before.quotaMb !== undefined &&
      (after.quotaMb === undefined ? false : after.quotaMb < before.quotaMb)
    ) {
      confirm.push(`shrink quota ${before.quotaMb}MB → ${after.quotaMb}MB`);
    } else if (after.quotaMb !== before.quotaMb) auto.push('quota');
  }
  if (confirm.length) return { gate: 'confirm', reason: `${after.name}: ${confirm.join('; ')}` };
  return {
    gate: 'auto',
    reason: `update ${after.name}${auto.length ? `: ${auto.join('; ')}` : ''}`,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

export function routeKey(r: { host: string; path: string }): string {
  return r.path === '/' ? r.host : `${r.host}${r.path}`;
}

/** Does any changed path fall under any watched path? (`.` watches everything.) */
export function touches(changed: readonly string[], watch: readonly string[]): boolean {
  return changed.some((c) => watch.some((w) => w === '.' || c === w || c.startsWith(`${w}/`)));
}

function typeRank(t: ResourceType): number {
  return t === 'postgres' ? 0 : t === 'vector' ? 2 : 1;
}

const KIND_ORDER = [
  'resource.create',
  'resource.update',
  'build',
  'service.deploy',
  'route.add',
  'route.update',
  'job.create',
  'job.update',
  'link.add',
  'route.remove',
  'job.remove',
  'link.remove',
  'service.remove',
  'resource.delete',
];
const kindRank = (k: string): number => KIND_ORDER.indexOf(k);

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

function describeResource(r: DesiredResource): string {
  switch (r.type) {
    case 'postgres':
      return `postgres ${r.version} "${r.name}" (${r.ha}${r.replicas ? ` + ${r.replicas} replica${r.replicas > 1 ? 's' : ''}` : ''})`;
    case 'cache':
      return `${r.engine} cache "${r.name}" (${r.memoryMb}MB)`;
    case 'search':
      return `${r.engine} search "${r.name}"`;
    case 'vector':
      return r.engine === 'pgvector' ? `pgvector on "${r.on}"` : `qdrant vector store "${r.name}"`;
    case 'bucket':
      return `${r.access} bucket "${r.name}"`;
  }
}

/** Field-level diff between two unit JSONs (sig ignored), dotted paths, leaves only. */
export function diffFields(before: unknown, after: unknown, base = ''): FieldChange[] {
  if (base === 'sig') return [];
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffFields(before[k], after[k], base ? `${base}.${k}` : k));
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  return [
    {
      path: base,
      ...(before !== undefined ? { from: before } : {}),
      ...(after !== undefined ? { to: after } : {}),
    },
  ];
}

/** The PR comment / check-run body for a plan. */
export function planToMarkdown(plan: Plan, extras: { previewUrl?: string } = {}): string {
  const icon: Record<Gate, string> = { auto: '+', confirm: '!', blocked: 'x' };
  const head =
    plan.status === 'noop'
      ? 'Nothing to change.'
      : plan.status === 'blocked'
        ? `Blocked — ${plan.counts.blocked} change${plan.counts.blocked > 1 ? 's' : ''} cannot be applied.`
        : plan.status === 'needs-confirmation'
          ? `${plan.counts.auto} change${plan.counts.auto === 1 ? '' : 's'} will apply; ${plan.counts.confirm} need${plan.counts.confirm === 1 ? 's' : ''} you in the dashboard.`
          : `${plan.counts.auto} change${plan.counts.auto === 1 ? '' : 's'} will apply.`;
  const lines = [`### swarmy plan for \`${plan.stack}\``, '', head];
  if (extras.previewUrl) lines.push('', `Preview: ${extras.previewUrl}`);
  if (plan.actions.length) {
    lines.push('', '```diff');
    for (const a of plan.actions) lines.push(`${icon[a.gate]} ${a.reason}`);
    lines.push('```');
  }
  return lines.join('\n');
}
