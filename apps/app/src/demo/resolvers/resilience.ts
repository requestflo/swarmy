import type { DemoStore, DomainResolvers } from '../types';

/**
 * Resilience demo resolvers — the Resilience surface (`/resilience`): readiness
 * score, problems and safe drills.
 *
 * Mirrors the F2 tRPC views exactly (`ResilienceOverviewView`,
 * `ResilienceDrillResultView`). The seed is the wishlist demo estate: score 82
 * (two warns + two infos = −18) with a restore drill that passed 2 days ago
 * ("RPO 5m · RTO 8m estimate"). Running a drill simulates a pass, prepends a
 * history row and updates the RPO/RTO derivations — the page feels live because
 * mutations invalidate and re-read this store.
 */

// ── view mirrors (resilience.service.ts) ──────────────────────────────────────

type Severity = 'crit' | 'warn' | 'info';
type DrillKind = 'restore' | 'backup-verify';

interface ProblemView {
  id: string;
  check: string;
  severity: Severity;
  title: string;
  detail: string;
  fixHint: string;
  fixPath: string;
  fixLabel: string;
  resource: string | null;
}

interface DrillStepView {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string | null;
  durationMs: number | null;
}

interface DrillResultView {
  kind: DrillKind;
  status: 'passed' | 'failed';
  at: string;
  durationMs: number;
  target: string | null;
  summary: string;
  steps: DrillStepView[];
  error: string | null;
}

interface DrillCardView {
  kind: DrillKind;
  available: boolean;
  unavailableReason: string | null;
  last: DrillResultView | null;
  rpoSeconds: number | null;
  rtoEstimateMs: number | null;
}

interface DrillTargetView {
  stack: string;
  cluster: string;
  topology: string;
  healthy: boolean;
  replicasRunning: number;
}

interface ResilienceState {
  problems: ProblemView[];
  history: DrillResultView[];
  /** ISO time of the latest successful backup (drives the RPO). */
  lastBackupAt: string;
  targets: DrillTargetView[];
}

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();

function getState(store: DemoStore): ResilienceState {
  return store.extra.resilience as ResilienceState;
}

function drillCards(st: ResilienceState): DrillCardView[] {
  const last = (kind: DrillKind): DrillResultView | null =>
    st.history.find((h) => h.kind === kind) ?? null;
  const lastPassedRestore = st.history.find((h) => h.kind === 'restore' && h.status === 'passed');
  return [
    {
      kind: 'restore',
      available: true,
      unavailableReason: null,
      last: last('restore'),
      rpoSeconds: Math.max(0, Math.round((Date.now() - new Date(st.lastBackupAt).getTime()) / 1000)),
      rtoEstimateMs: lastPassedRestore?.durationMs ?? null,
    },
    {
      kind: 'backup-verify',
      available: true,
      unavailableReason: null,
      last: last('backup-verify'),
      rpoSeconds: null,
      rtoEstimateMs: null,
    },
  ];
}

function runDemoDrill(st: ResilienceState, kind: DrillKind, target: string | null): DrillResultView {
  const steps: DrillStepView[] =
    kind === 'restore'
      ? [
          { name: 'Create throwaway cluster', status: 'passed', detail: 'deployed data_drill-mc41k2-primary', durationMs: 42_000 },
          { name: 'Wait for postgres', status: 'passed', detail: null, durationMs: 21_000 },
          { name: 'Restore snapshot a1b2c3d4', status: 'passed', detail: '412331520 bytes restored', durationMs: 384_000 },
          { name: 'Verify SELECT 1', status: 'passed', detail: null, durationMs: 900 },
          { name: 'Destroy the clone', status: 'passed', detail: null, durationMs: 3_400 },
        ]
      : [{ name: 'restic check on "hetzner-s3"', status: 'passed', detail: 'exit 0', durationMs: 39_000 }];
  const durationMs = steps.reduce((sum, s) => sum + (s.durationMs ?? 0), 0);
  const result: DrillResultView = {
    kind,
    status: 'passed',
    at: new Date().toISOString(),
    durationMs,
    target,
    summary:
      kind === 'restore'
        ? `Restored a1b2c3d4 into drill-${Date.now().toString(36)}, verified SELECT 1, destroyed the clone.`
        : 'restic check on "hetzner-s3" passed — no errors were found.',
    steps,
    error: null,
  };
  st.history = [result, ...st.history].slice(0, 20);
  return result;
}

// Mirrors resilience.service.ts's stack scoping: real checks with
// `resource: null` are estate-wide (gated only on the stack having any
// services, which every seeded demo stack does) so they show for every
// stack; resource-bearing checks match when the resource names that stack.
// `single-replica` aggregates service names rather than a stack ref — grafana
// and prometheus are seeded under the `platform` stack (see resolvers/data.ts).
function problemMatchesStack(p: ProblemView, stack: string): boolean {
  if (p.check === 'geodns-single-region') return true;
  if (!p.resource) return true;
  if (p.resource.includes(stack)) return true;
  if (p.check === 'single-replica') return stack === 'platform';
  return false;
}

// ── resolvers ─────────────────────────────────────────────────────────────────

export const resilience: DomainResolvers = {
  handlers: {
    'resilience.overview': (i, s) => {
      const stack = (i as { stack?: string } | null | undefined)?.stack;
      const st = getState(s);
      const scoped = stack ? { ...st, problems: st.problems.filter((p) => problemMatchesStack(p, stack)) } : st;
      return {
        ready: true as const,
        problems: scoped.problems,
        generatedAt: new Date().toISOString(),
        drills: drillCards(st),
        drillTargets: stack ? st.targets.filter((t) => t.stack === stack) : st.targets,
      };
    },

    'resilience.drillHistory': (i, s) => {
      const f = (i as { limit?: number; stack?: string } | undefined) ?? {};
      const limit = f.limit ?? 20;
      const history = getState(s).history.filter(
        (h) => !f.stack || (h.target ?? '').startsWith(`${f.stack}/`),
      );
      return history.slice(0, limit);
    },

    'resilience.runRestoreDrill': (i, s) => {
      const b = i as { stack: string; cluster: string };
      return runDemoDrill(getState(s), 'restore', `${b.stack}/${b.cluster}`);
    },

    'resilience.runBackupVerify': (_i, s) => runDemoDrill(getState(s), 'backup-verify', 'hetzner-s3'),
  },

  seed: (store) => {
    // The demo posture: 2 warns + 2 infos.
    const problems: ProblemView[] = [
      {
        id: 'single-replica',
        check: 'single-replica',
        severity: 'warn',
        title: '2 services run a single replica',
        detail: 'grafana, prometheus — one task means one crash or one node loss takes them offline.',
        fixHint: 'Scale to 2+ replicas so the scheduler can reschedule around failures.',
        fixPath: '/',
        fixLabel: 'Scale the service',
        resource: 'grafana, prometheus',
      },
      {
        id: 'cache-no-replica/platform/sessions',
        check: 'cache-no-replica',
        severity: 'warn',
        title: 'Cache platform/sessions has no replica',
        detail: 'A single-node cache loses every key (and every session) when its task dies.',
        fixHint: 'Switch the cluster to replica or sentinel topology on the Data page.',
        fixPath: '/stacks/platform/data',
        fixLabel: 'Add a replica',
        resource: 'platform/sessions',
      },
      {
        id: 'db-topology/data/main',
        check: 'db-topology',
        severity: 'info',
        title: 'Database data/main has no standby',
        detail: 'Topology is "single" — one copy of the data, no failover.',
        fixHint: 'Move the cluster to primary-replica (or failover) topology with ≥1 replica.',
        fixPath: '/stacks/data/data',
        fixLabel: 'Change topology',
        resource: 'data/main',
      },
      {
        id: 'geodns-single-region',
        check: 'geodns-single-region',
        severity: 'info',
        title: 'Geo-DNS answers from one region on a 3-region estate',
        detail:
          'cdn.geo.northwind.dev only resolves from us-east while your nodes span ap-south, eu-west, us-east.',
        fixHint: 'Add Geo-DNS records for each region so DNS fails over by omission.',
        fixPath: '/ingress',
        fixLabel: 'Add regional records',
        resource: 'cdn.geo.northwind.dev',
      },
    ];

    const history: DrillResultView[] = [
      {
        kind: 'backup-verify',
        status: 'passed',
        at: iso(6 * HOUR),
        durationMs: 41_000,
        target: 'hetzner-s3',
        summary: 'restic check on "hetzner-s3" passed — no errors were found.',
        steps: [
          { name: 'restic check on "hetzner-s3"', status: 'passed', detail: 'exit 0', durationMs: 41_000 },
        ],
        error: null,
      },
      {
        kind: 'restore',
        status: 'passed',
        at: iso(2 * DAY),
        durationMs: 8 * MIN,
        target: 'data/main',
        summary: 'Restored a1b2c3d4 into drill-lyx2m9, verified SELECT 1, destroyed the clone.',
        steps: [
          { name: 'Create throwaway cluster', status: 'passed', detail: 'deployed data_drill-lyx2m9-primary', durationMs: 44_000 },
          { name: 'Wait for postgres', status: 'passed', detail: null, durationMs: 24_000 },
          { name: 'Restore snapshot a1b2c3d4', status: 'passed', detail: '398163968 bytes restored', durationMs: 401_000 },
          { name: 'Verify SELECT 1', status: 'passed', detail: null, durationMs: 850 },
          { name: 'Destroy the clone', status: 'passed', detail: null, durationMs: 3_100 },
        ],
        error: null,
      },
      {
        kind: 'restore',
        status: 'failed',
        at: iso(20 * DAY),
        durationMs: 3 * MIN,
        target: 'data/main',
        summary: 'Restore drill against data/main failed.',
        steps: [
          { name: 'Create throwaway cluster', status: 'passed', detail: 'deployed data_drill-kq8n1p-primary', durationMs: 46_000 },
          { name: 'Wait for postgres', status: 'failed', detail: 'postgres in "data_drill-kq8n1p-primary" never became ready: no space left on device', durationMs: 120_000 },
        ],
        error: 'postgres in "data_drill-kq8n1p-primary" never became ready: no space left on device',
      },
    ];

    const state: ResilienceState = {
      problems,
      history,
      lastBackupAt: iso(5 * MIN), // RPO 5m
      targets: [
        { stack: 'storefront', cluster: 'main', topology: 'primary-replica', healthy: true, replicasRunning: 2 },
        { stack: 'data', cluster: 'main', topology: 'single', healthy: true, replicasRunning: 0 },
      ],
    };
    store.extra.resilience = state;
  },
};
