import type { DemoStore, DomainResolvers } from '../types';

/**
 * GitOps apps demo resolvers (router `apps`) — the "Apps from Git" card and
 * Plan drawer on /ci.
 *
 * State lives in `store.extra.apps`. Shapes mirror AppView / AppPlanView in
 * packages/trpc/src/services/apps.service.ts and the @swarmy/app-config Plan.
 * Seed: `storefront` (matches the demo stack, so its Releases tab shows the
 * From Git panel) with production applied — including a removed Postgres
 * `analytics` whose volume can be purged — staging holding
 * `resource.delete:search` for a confirm, a PR preview, and a branch preview
 * (feature/login) with a scrubbed copy of production's data; and `payments`
 * (a monorepo path, Fix drift on) whose latest production plan is an invalid
 * swarmy.yaml.
 *
 * Every read returns a structuredClone: the demo link hands results straight
 * to the query cache, and structural sharing would otherwise see an in-place
 * edit of the store as "unchanged".
 */

type Gate = 'auto' | 'confirm' | 'blocked';

interface Action {
  id: string;
  kind: string;
  phase: number;
  gate: Gate;
  reason: string;
  name?: string;
  resourceType?: string;
  host?: string;
  path?: string;
}

interface PlanRow {
  /** Branch previews: the branch, and a data copy when previews.data is on. */
  previewBranch?: string;
  previewData?: { from: string; scrub?: string };
  id: string;
  repoId: string;
  environment: string;
  stack: string;
  sha: string;
  trigger: string;
  prNumber: number | null;
  status: string;
  plan: { stack: string; status: string; actions: Action[]; counts: Record<Gate, number> } | null;
  issues: Array<{
    severity: 'error' | 'warning';
    code: string;
    message: string;
    path: (string | number)[];
    line?: number;
    col?: number;
  }>;
  outcomes: Record<string, { status: 'done' | 'held' | 'failed' | 'skipped'; message?: string }>;
  error: string | null;
  confirmedIds: string[];
  markdown: string;
  createdAt: string;
  appliedAt: string | null;
}

interface AppRow {
  repoId: string;
  url: string;
  fullName: string;
  branch: string;
  configPath: string;
  appName: string;
  requireApproval: boolean;
  enforceDrift: boolean;
  /** Postgres removed from swarmy.yaml whose volume is still on disk (purgeData). */
  keptVolumes: Record<string, Array<{ resource: string; volumes: string[] }>>;
  /** Extra environment branches (staging, …) → environment name. */
  envBranches: Record<string, string>;
  drift: Record<string, number>;
  driftCheckedAt: string;
}

interface AppsState {
  apps: AppRow[];
  plans: PlanRow[];
}

const MIN = 60_000;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();
const hex = (n: number): string =>
  Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
const clone = <T>(v: T): T => structuredClone(v);

function counts(actions: Action[]): Record<Gate, number> {
  const c: Record<Gate, number> = { auto: 0, confirm: 0, blocked: 0 };
  for (const a of actions) c[a.gate] += 1;
  return c;
}

function plan(p: Omit<PlanRow, 'plan' | 'markdown'> & { actions: Action[] | null }): PlanRow {
  const { actions, ...rest } = p;
  return {
    ...rest,
    plan: actions
      ? {
          stack: p.stack,
          status:
            p.status === 'needs-confirmation'
              ? 'needs-confirmation'
              : actions.length
                ? 'ready'
                : 'noop',
          actions,
          counts: counts(actions),
        }
      : null,
    markdown: '',
  };
}

const STOREFRONT_ROLLOUT: Action[] = [
  {
    id: 'build:web',
    kind: 'build',
    phase: 2,
    gate: 'auto',
    reason: 'Build web from ./web (Dockerfile)',
  },
  {
    id: 'service.deploy:web',
    kind: 'service.deploy',
    phase: 4,
    gate: 'auto',
    reason: 'Roll out web with the new image',
    name: 'web',
  },
  {
    id: 'route.update:storefront.northwind.dev/',
    kind: 'route.update',
    phase: 5,
    gate: 'auto',
    reason: 'Point storefront.northwind.dev at web',
    host: 'storefront.northwind.dev',
    path: '/',
  },
];

/** A Postgres dropped from swarmy.yaml, confirmed and removed — its volume is kept until purged. */
const ANALYTICS_REMOVED: Action = {
  id: 'resource.delete:analytics',
  kind: 'resource.delete',
  phase: 6,
  gate: 'confirm',
  reason: 'remove postgres "analytics" — its data volume is kept until you delete it permanently',
  name: 'analytics',
  resourceType: 'postgres',
};

function buildSeed(): AppsState {
  const prodSha = hex(40);
  const stagingSha = hex(40);
  return {
    apps: [
      {
        repoId: 'app-storefront',
        url: 'https://github.com/northwind/storefront.git',
        fullName: 'northwind/storefront',
        branch: 'main',
        configPath: 'swarmy.yaml',
        appName: 'storefront',
        requireApproval: false,
        enforceDrift: false,
        keptVolumes: {
          production: [
            {
              resource: 'analytics',
              volumes: [
                'storefront_analytics-data',
                'storefront_analytics-replica',
                'storefront_analytics-wal',
              ],
            },
          ],
        },
        envBranches: { staging: 'staging' },
        drift: { production: 1 },
        driftCheckedAt: iso(6 * MIN),
      },
      {
        repoId: 'app-payments',
        url: 'https://github.com/northwind/platform.git',
        fullName: 'northwind/platform',
        branch: 'main',
        configPath: 'services/payments/swarmy.yaml',
        appName: 'payments',
        requireApproval: true,
        enforceDrift: true,
        keptVolumes: {},
        envBranches: {},
        drift: {},
        driftCheckedAt: iso(4 * MIN),
      },
    ],
    plans: [
      plan({
        id: 'plan-storefront-prod',
        repoId: 'app-storefront',
        environment: 'production',
        stack: 'storefront',
        sha: prodSha,
        trigger: 'push',
        prNumber: null,
        status: 'applied',
        actions: [...STOREFRONT_ROLLOUT, ANALYTICS_REMOVED],
        issues: [],
        outcomes: Object.fromEntries(
          [...STOREFRONT_ROLLOUT, ANALYTICS_REMOVED].map((a) => [
            a.id,
            { status: 'done' as const },
          ]),
        ),
        error: null,
        confirmedIds: [ANALYTICS_REMOVED.id],
        createdAt: iso(3 * 60 * MIN),
        appliedAt: iso(3 * 60 * MIN - 2 * MIN),
      }),
      plan({
        id: 'plan-storefront-staging',
        repoId: 'app-storefront',
        environment: 'staging',
        stack: 'storefront-staging',
        sha: stagingSha,
        trigger: 'push',
        prNumber: null,
        status: 'needs-confirmation',
        actions: [
          ...STOREFRONT_ROLLOUT.slice(0, 2),
          {
            id: 'resource.update:db',
            kind: 'resource.update',
            phase: 1,
            gate: 'auto',
            reason: 'Grow db storage 10 GB → 20 GB',
            name: 'db',
            resourceType: 'postgres',
          },
          {
            id: 'resource.delete:search',
            kind: 'resource.delete',
            phase: 6,
            gate: 'confirm',
            reason: 'Delete search index “search”',
            name: 'search',
            resourceType: 'search index',
          },
        ],
        issues: [],
        outcomes: {
          'build:web': { status: 'done' },
          'service.deploy:web': { status: 'done' },
          'resource.update:db': { status: 'done' },
          'resource.delete:search': {
            status: 'held',
            message: 'removed from swarmy.yaml — deleting it drops 1.2 GB of indexed data',
          },
        },
        error: null,
        confirmedIds: [],
        createdAt: iso(22 * MIN),
        appliedAt: null,
      }),
      plan({
        id: 'plan-storefront-pr142',
        repoId: 'app-storefront',
        environment: 'preview',
        stack: 'pr142-storefront',
        sha: hex(40),
        trigger: 'pr',
        prNumber: 142,
        status: 'applied',
        actions: STOREFRONT_ROLLOUT.slice(0, 2),
        issues: [],
        outcomes: { 'build:web': { status: 'done' }, 'service.deploy:web': { status: 'done' } },
        error: null,
        confirmedIds: [],
        createdAt: iso(50 * MIN),
        appliedAt: iso(47 * MIN),
      }),
      {
        ...plan({
          id: 'plan-storefront-branch-login',
          repoId: 'app-storefront',
          environment: 'preview',
          stack: 'br-feature-login-storefront',
          sha: hex(40),
          trigger: 'push',
          prNumber: 90412,
          status: 'applied',
          actions: [
            STOREFRONT_ROLLOUT[0] as Action,
            {
              id: 'resource.create:db',
              kind: 'resource.create',
              phase: 1,
              gate: 'auto',
              reason:
                'create postgres "db" — a COPY of production\'s latest backup, scrubbed by db/scrub.sql; destroyed with the preview',
              name: 'db',
              resourceType: 'postgres',
            },
            STOREFRONT_ROLLOUT[1] as Action,
          ],
          issues: [],
          outcomes: {
            'build:web': { status: 'done' },
            'resource.create:db': { status: 'done', message: 'restored 2.1 GB, scrub ran clean' },
            'service.deploy:web': { status: 'done' },
          },
          error: null,
          confirmedIds: [],
          createdAt: iso(30 * MIN),
          appliedAt: iso(24 * MIN),
        }),
        previewBranch: 'feature/login',
        previewData: { from: 'production', scrub: 'db/scrub.sql' },
      },
      plan({
        id: 'plan-payments-prod',
        repoId: 'app-payments',
        environment: 'production',
        stack: 'payments',
        sha: hex(40),
        trigger: 'push',
        prNumber: null,
        status: 'invalid',
        actions: null,
        issues: [
          {
            severity: 'error',
            code: 'binding/unknown-resource',
            message:
              'DATABASE_URL points at “ledger”, but no resource is called that. Did you mean “ledger-db”?',
            path: ['services', 'api', 'env', 'DATABASE_URL'],
            line: 14,
            col: 21,
          },
          {
            severity: 'error',
            code: 'schema/type',
            message: 'replicas must be a whole number, got “two”.',
            path: ['services', 'api', 'replicas'],
            line: 9,
            col: 15,
          },
          {
            severity: 'warning',
            code: 'route/no-healthcheck',
            message:
              'api has a public domain but no healthcheck — a bad deploy would take it down.',
            path: ['services', 'api'],
            line: 6,
          },
        ],
        outcomes: {},
        error: null,
        confirmedIds: [],
        createdAt: iso(8 * MIN),
        appliedAt: null,
      }),
    ],
  };
}

function state(s: DemoStore): AppsState {
  const existing = s.extra['apps'] as AppsState | undefined;
  if (existing) return existing;
  const fresh = buildSeed();
  s.extra['apps'] = fresh;
  return fresh;
}

function driftEnvs(app: AppRow): Array<{ environment: string; stack: string; changes: number }> {
  return Object.entries(app.drift).map(([environment, changes]) => ({
    environment,
    stack: environment === 'production' ? app.appName : `${app.appName}-${environment}`,
    changes,
  }));
}

const newest = (rows: PlanRow[]): PlanRow[] =>
  [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

function latestFor(st: AppsState, repoId: string, env: string): PlanRow | null {
  return (
    newest(
      st.plans.filter((p) => p.repoId === repoId && p.environment === env && !p.prNumber),
    )[0] ?? null
  );
}

export const apps: DomainResolvers = {
  seed: (store) => {
    store.extra['apps'] = buildSeed();
  },

  handlers: {
    'apps.list': (_i, s) => {
      const st = state(s);
      return clone(
        st.apps.map((a) => ({
          repoId: a.repoId,
          url: a.url,
          fullName: a.fullName,
          branch: a.branch,
          configPath: a.configPath,
          appName: a.appName,
          requireApproval: a.requireApproval,
          enforceDrift: a.enforceDrift,
          previews: newest(st.plans.filter((p) => p.repoId === a.repoId && p.prNumber)).map(
            (p) => ({
              ...(p.previewBranch ? { branch: p.previewBranch } : {}),
              ...(p.previewData ? { data: p.previewData } : {}),
              pr: p.prNumber as number,
              stack: p.stack,
              sha: p.sha,
              status: p.status,
              url: p.previewBranch
                ? `https://${p.previewBranch.replace(/\//g, '-')}.preview.northwind.dev`
                : `https://pr-${p.prNumber}.preview.northwind.dev`,
              updatedAt: p.appliedAt ?? p.createdAt,
              planId: p.id,
            }),
          ),
          drift: { checkedAt: a.driftCheckedAt, environments: driftEnvs(a) },
          environments: [
            {
              environment: 'production',
              branch: a.branch,
              stack: a.appName,
              latest: latestFor(st, a.repoId, 'production'),
              keptVolumes: a.keptVolumes['production'] ?? [],
            },
            ...Object.entries(a.envBranches).map(([env, branch]) => ({
              environment: env,
              branch,
              stack: `${a.appName}-${env}`,
              latest: latestFor(st, a.repoId, env),
              keptVolumes: a.keptVolumes[env] ?? [],
            })),
          ],
        })),
      );
    },

    'apps.plan': (i, s) => {
      const { planId } = i as { planId: string };
      const row = state(s).plans.find((p) => p.id === planId);
      if (!row) throw new Error('That plan is gone.');
      return clone(row);
    },

    'apps.confirm': (i, s) => {
      const { planId, actionIds } = i as { planId: string; actionIds: string[] };
      const row = state(s).plans.find((p) => p.id === planId);
      if (!row || row.status !== 'needs-confirmation')
        throw new Error('There is nothing to confirm on this plan.');
      for (const id of actionIds) {
        row.confirmedIds.push(id);
        row.outcomes[id] = { status: 'done', message: 'confirmed and applied' };
      }
      const stillHeld = Object.values(row.outcomes).some((o) => o.status === 'held');
      if (!stillHeld) {
        row.status = 'applied';
        row.appliedAt = new Date().toISOString();
      }
      return { status: row.status, confirmed: actionIds };
    },

    'apps.setRequireApproval': (i, s) => {
      const { repoId, requireApproval } = i as { repoId: string; requireApproval: boolean };
      const app = state(s).apps.find((a) => a.repoId === repoId);
      if (app) app.requireApproval = requireApproval;
      return { repoId, requireApproval };
    },

    'apps.deploy': (i, s) => {
      const { repoId, branch } = i as { repoId: string; branch?: string };
      const st = state(s);
      const app = st.apps.find((a) => a.repoId === repoId);
      if (!app) throw new Error('That app is gone.');
      const env =
        branch && branch !== app.branch ? (app.envBranches[branch] ?? 'production') : 'production';
      const prev = latestFor(st, repoId, env);
      if (prev && prev.status === 'invalid') {
        return {
          planId: prev.id,
          status: 'invalid',
          environment: env,
          stack: prev.stack,
          reason: 'swarmy.yaml still has errors on the branch head',
          plan: clone(prev),
        };
      }
      if (prev) prev.status = prev.status === 'applied' ? 'applied' : 'superseded';
      const next = plan({
        id: `plan-${Math.random().toString(36).slice(2, 10)}`,
        repoId,
        environment: env,
        stack: prev?.stack ?? app.appName,
        sha: hex(40),
        trigger: 'manual',
        prNumber: null,
        status: 'applied',
        actions: [],
        issues: [],
        outcomes: {},
        error: null,
        confirmedIds: [],
        createdAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
      });
      st.plans.push(next);
      app.drift[env] = 0;
      return {
        planId: next.id,
        status: next.status,
        environment: env,
        stack: next.stack,
        plan: clone(next),
      };
    },

    'apps.drift': (i, s) => {
      const { repoId } = i as { repoId: string };
      const app = state(s).apps.find((a) => a.repoId === repoId);
      if (!app) return { checkedAt: new Date().toISOString(), environments: [] };
      app.driftCheckedAt = new Date().toISOString();
      return { checkedAt: app.driftCheckedAt, environments: driftEnvs(app) };
    },

    'apps.setEnforceDrift': (i, s) => {
      const { repoId, enforceDrift } = i as { repoId: string; enforceDrift: boolean };
      const app = state(s).apps.find((a) => a.repoId === repoId);
      if (app) {
        app.enforceDrift = enforceDrift;
        if (enforceDrift) app.drift = Object.fromEntries(Object.keys(app.drift).map((k) => [k, 0]));
      }
      return { repoId, enforceDrift };
    },

    'apps.purgeData': (i, s) => {
      const { repoId, environment, resource, confirm } = i as {
        repoId: string;
        environment: string;
        resource: string;
        confirm: string;
      };
      const st = state(s);
      const app = st.apps.find((a) => a.repoId === repoId);
      const row = latestFor(st, repoId, environment);
      if (!app || !row) throw new Error('That app environment is gone.');
      const expected = `${row.stack}/${resource}`;
      if (confirm !== expected) throw new Error(`type ${expected} to delete its data permanently`);
      const kept = (app.keptVolumes[environment] ?? []).find((k) => k.resource === resource);
      if (!kept) throw new Error(`${resource} has no kept data to delete`);
      app.keptVolumes[environment] = (app.keptVolumes[environment] ?? []).filter((k) => k !== kept);
      return { stack: row.stack, resource, volumes: kept.volumes, nodes: 2 };
    },

    'apps.promote': (i, s) => {
      const { repoId, from } = i as { repoId: string; from: string };
      const st = state(s);
      const app = st.apps.find((a) => a.repoId === repoId);
      if (!app) throw new Error('That app is gone.');
      if (from === 'production')
        throw new Error('promote FROM a named environment (e.g. staging) to production');
      const src = latestFor(st, repoId, from);
      if (!src || !['applied', 'needs-confirmation'].includes(src.status))
        throw new Error(`${from} has nothing applied to promote yet`);
      const services = (src.plan?.actions ?? []).filter(
        (a) => a.kind === 'service.deploy' && a.name,
      );
      const images = Object.fromEntries(
        services.map((a) => [
          a.name as string,
          `ghcr.io/northwind/${app.appName}-${a.name}@sha256:${hex(64)}`,
        ]),
      );
      const actions: Action[] = services.map((a) => ({
        id: `service.deploy:${a.name}`,
        kind: 'service.deploy',
        phase: 4,
        gate: 'auto',
        reason: `Roll out ${a.name} with ${from}'s image (no rebuild)`,
        name: a.name,
      }));
      const next = plan({
        id: `plan-${Math.random().toString(36).slice(2, 10)}`,
        repoId,
        environment: 'production',
        stack: app.appName,
        sha: src.sha,
        trigger: 'promote',
        prNumber: null,
        status: 'applied',
        actions,
        issues: [],
        outcomes: Object.fromEntries(actions.map((a) => [a.id, { status: 'done' as const }])),
        error: null,
        confirmedIds: [],
        createdAt: new Date().toISOString(),
        appliedAt: new Date().toISOString(),
      });
      st.plans.push(next);
      return {
        planId: next.id,
        status: next.status,
        environment: 'production',
        stack: next.stack,
        plan: clone(next),
        images,
      };
    },
  },
};
