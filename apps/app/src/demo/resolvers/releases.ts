import type {
  CanaryAbortResult,
  CanaryPromoteResult,
  CanaryRunView,
  ComposeDiffLine,
  DeploySafetyView,
  ReleaseDetailView,
  ReleasesOverview,
  ReleaseView,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Releases demo resolvers — the Releases surface (`/releases`): deploy history,
 * health gates, compose diffs and rollback. Return shapes mirror
 * `releases.service.ts` views exactly (imported from @swarmy/core, never
 * redeclared). State lives in `store.extra.releases`; rollback mutates it so
 * the feed reflects the new deploying release after invalidation.
 */

interface ReleaseSeed extends ReleaseView {
  composeSource: string;
}

interface ReleasesState {
  releases: ReleaseSeed[];
  /** stackName → safety settings (mirrors the swarmy.deploy.safety label). */
  safety: Record<string, { enabled: boolean; windowSec: number; autoRollback: boolean }>;
}

function getState(store: DemoStore): ReleasesState {
  return store.extra.releases as ReleasesState;
}

function rid(): string {
  return `rel-${Math.random().toString(36).slice(2, 10)}`;
}

const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (agoMs: number): string => new Date(Date.now() - agoMs).toISOString();

// ── pure mirror of releases.service diffLines (LCS line diff) ────────────────

function diffLines(a: string, b: string): ComposeDiffLine[] {
  const al = a.length ? a.split('\n') : [];
  const bl = b.length ? b.split('\n') : [];
  const n = al.length;
  const m = bl.length;
  const w = m + 1;
  const lcs = new Int32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * w + j] =
        al[i] === bl[j]
          ? (lcs[(i + 1) * w + j + 1] ?? 0) + 1
          : Math.max(lcs[(i + 1) * w + j] ?? 0, lcs[i * w + j + 1] ?? 0);
    }
  }
  const out: ComposeDiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const ai = al[i] ?? '';
    const bj = bl[j] ?? '';
    if (ai === bj) {
      out.push({ kind: 'same', aLine: i + 1, bLine: j + 1, text: ai });
      i++;
      j++;
    } else if ((lcs[(i + 1) * w + j] ?? 0) >= (lcs[i * w + j + 1] ?? 0)) {
      out.push({ kind: 'del', aLine: i + 1, bLine: null, text: ai });
      i++;
    } else {
      out.push({ kind: 'add', aLine: null, bLine: j + 1, text: bj });
      j++;
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', aLine: i + 1, bLine: null, text: al[i] ?? '' });
  for (; j < m; j++) out.push({ kind: 'add', aLine: null, bLine: j + 1, text: bl[j] ?? '' });
  return out;
}

// ── seed compose sources (small but believable) ──────────────────────────────

const storefrontCompose = (webTag: string, apiTag: string, workerReplicas: number): string =>
  [
    'services:',
    '  web:',
    `    image: ghcr.io/northwind/storefront-web:${webTag}`,
    '    ports:',
    '      - "3000:3000"',
    '  api:',
    `    image: ghcr.io/northwind/storefront-api:${apiTag}`,
    '    environment:',
    '      - NODE_ENV=production',
    '  worker:',
    `    image: ghcr.io/northwind/storefront-worker:${apiTag}`,
    '    deploy:',
    `      replicas: ${workerReplicas}`,
  ].join('\n');

const platformCompose = (tag: string, withCache: boolean): string =>
  [
    'services:',
    '  gateway:',
    `    image: ghcr.io/northwind/platform-gateway:${tag}`,
    '    ports:',
    '      - "8080:8080"',
    ...(withCache ? ['  cache:', '    image: valkey/valkey:8'] : []),
    '  auth:',
    `    image: ghcr.io/northwind/platform-auth:${tag}`,
  ].join('\n');

function toView(r: ReleaseSeed): ReleaseView {
  const { composeSource: _omit, ...view } = r;
  return view;
}

// ── canary (D2) — lazily-seeded so the D1 seed above stays untouched ─────────

/** Stored without elapsed/remaining; those are recomputed live on every read. */
type CanarySeed = Omit<CanaryRunView, 'elapsedMin' | 'remainingMin'>;

/** One in-flight canary at 10% on the storefront web service. */
function seedCanaries(): CanarySeed[] {
  return [
    {
      stack: 'storefront',
      service: 'storefront_web',
      canaryService: 'storefront_web--canary',
      stableImage: 'ghcr.io/northwind/storefront-web:1.8.2',
      canaryImage: 'ghcr.io/northwind/storefront-web:1.9.0',
      trafficPct: 10,
      durationMin: 15,
      rollbackOnErrorRatePct: 5,
      startedAt: iso(6 * MIN),
      routedHosts: ['shop.northwind.dev'],
      stableReplicas: { desired: 3, running: 3 },
      canaryReplicas: { desired: 1, running: 1 },
      stableRed: { errorRatePct: 0.42, p95Ms: 118 },
      canaryRed: { errorRatePct: 1.16, p95Ms: 131 },
    },
  ];
}

function getCanaries(store: DemoStore): CanarySeed[] {
  const existing = store.extra.releasesCanary as CanarySeed[] | undefined;
  if (existing) return existing;
  const seeded = seedCanaries();
  store.extra.releasesCanary = seeded;
  return seeded;
}

function canaryToView(c: CanarySeed): CanaryRunView {
  const elapsedMin = Math.max(0, (Date.now() - Date.parse(c.startedAt)) / 60_000);
  return {
    ...c,
    elapsedMin: Math.round(elapsedMin * 10) / 10,
    remainingMin: Math.max(0, Math.round((c.durationMin - elapsedMin) * 10) / 10),
  };
}

// ── resolvers ────────────────────────────────────────────────────────────────

export const releases: DomainResolvers = {
  handlers: {
    'releases.overview': (_i, s): ReleasesOverview => {
      const rows = getState(s).releases;
      const count = (st: ReleaseView['status']) => rows.filter((r) => r.status === st).length;
      return {
        total: rows.length,
        deploying: count('deploying'),
        healthy: count('healthy'),
        failed: count('failed'),
        rolledBack: count('rolled-back'),
        lastDeployAt: rows[0]?.createdAt ?? null,
      };
    },

    'releases.list': (i, s): ReleaseView[] => {
      const b = (i as { stackName?: string; limit?: number } | undefined) ?? {};
      const rows = getState(s).releases.filter((r) => !b.stackName || r.stackName === b.stackName);
      return rows.slice(0, b.limit ?? 30).map(toView);
    },

    'releases.get': (i, s): ReleaseDetailView => {
      const { id } = i as { id: string };
      const st = getState(s);
      const row = st.releases.find((r) => r.id === id);
      if (!row) throw new Error(`release "${id}" not found`);
      const idx = st.releases.indexOf(row);
      const prev = st.releases.slice(idx + 1).find((r) => r.stackName === row.stackName);
      return {
        ...toView(row),
        composeSource: row.composeSource,
        previousId: prev?.id ?? null,
        diff: diffLines(prev?.composeSource ?? '', row.composeSource),
      };
    },

    'releases.rollback': (i, s): { releaseId: string; deploymentId: string } => {
      const { releaseId } = i as { releaseId: string; override?: boolean };
      const st = getState(s);
      const target = st.releases.find((r) => r.id === releaseId);
      if (!target) throw new Error(`release "${releaseId}" not found`);
      const head = st.releases.find(
        (r) => r.stackName === target.stackName && ['deploying', 'healthy', 'failed'].includes(r.status),
      );
      if (head) head.status = 'rolled-back';
      const gate = st.safety[target.stackName];
      const next: ReleaseSeed = {
        ...target,
        id: rid(),
        status: 'deploying',
        actor: s.user.email,
        notes: `Rollback to release ${target.id}`,
        healthGate: gate?.enabled ? { windowSec: gate.windowSec, autoRollback: gate.autoRollback } : null,
        createdAt: new Date().toISOString(),
      };
      st.releases = [next, ...st.releases];
      // Settle it shortly so the demo feed shows the gate passing.
      setTimeout(() => {
        next.status = 'healthy';
      }, 8_000);
      return { releaseId: next.id, deploymentId: `dep-${next.id}` };
    },

    'releases.getSafety': (i, s): DeploySafetyView => {
      const { stackName } = i as { stackName: string };
      const st = getState(s);
      const gate = st.safety[stackName] ?? { enabled: false, windowSec: 120, autoRollback: false };
      return {
        stackName,
        enabled: gate.enabled,
        windowSec: gate.windowSec,
        autoRollback: gate.autoRollback,
        strategy: stackName === 'storefront' ? { type: 'canary', trafficPct: 10, durationMin: 15 } : null,
      };
    },

    'releases.setSafety': (i, s): DeploySafetyView => {
      const b = i as { stackName: string; enabled: boolean; windowSec: number; autoRollback: boolean };
      const st = getState(s);
      st.safety[b.stackName] = {
        enabled: b.enabled,
        windowSec: b.windowSec,
        autoRollback: b.autoRollback,
      };
      return {
        stackName: b.stackName,
        enabled: b.enabled,
        windowSec: b.windowSec,
        autoRollback: b.autoRollback,
        strategy: b.stackName === 'storefront' ? { type: 'canary', trafficPct: 10, durationMin: 15 } : null,
      };
    },

    // ── canary (D2) ───────────────────────────────────────────────────────────

    'releases.canaryStatus': (i, s): CanaryRunView[] => {
      const { stack } = (i as { stack?: string } | undefined) ?? {};
      return getCanaries(s)
        .filter((c) => !stack || c.stack === stack)
        .map(canaryToView);
    },

    'releases.startCanary': (i, s): CanaryRunView => {
      const b = i as {
        stack: string;
        service: string;
        image: string;
        trafficPct?: number;
        durationMin?: number;
        rollbackOnErrorRatePct?: number | null;
      };
      const canaries = getCanaries(s);
      const name = b.service.includes('_') ? b.service : `${b.stack}_${b.service}`;
      if (canaries.some((c) => c.service === name)) {
        throw new Error(`a canary for "${name}" is already running — promote or abort it first`);
      }
      const stable = s.services.find((sv) => sv.name === b.service || `${b.stack}_${sv.name}` === name);
      const next: CanarySeed = {
        stack: b.stack,
        service: name,
        canaryService: `${name}--canary`,
        stableImage: stable?.image ?? 'ghcr.io/northwind/storefront-web:1.8.2',
        canaryImage: b.image,
        trafficPct: b.trafficPct ?? 10,
        durationMin: b.durationMin ?? 15,
        rollbackOnErrorRatePct: b.rollbackOnErrorRatePct ?? null,
        startedAt: new Date().toISOString(),
        routedHosts: ['shop.northwind.dev'],
        stableReplicas: { desired: 3, running: 3 },
        canaryReplicas: { desired: 1, running: 0 },
        stableRed: { errorRatePct: 0.42, p95Ms: 118 },
        canaryRed: { errorRatePct: null, p95Ms: null },
      };
      canaries.push(next);
      // The canary converges + starts reporting telemetry shortly after.
      setTimeout(() => {
        next.canaryReplicas = { desired: 1, running: 1 };
        next.canaryRed = { errorRatePct: 0.9, p95Ms: 124 };
      }, 6_000);
      return canaryToView(next);
    },

    'releases.promote': (i, s): CanaryPromoteResult => {
      const b = i as { stack: string; service: string };
      const canaries = getCanaries(s);
      const idx = canaries.findIndex(
        (c) => c.stack === b.stack && (c.service === b.service || c.service === `${b.stack}_${b.service}`),
      );
      const run = canaries[idx];
      if (!run) throw new Error(`canary "${b.service}" not found`);
      canaries.splice(idx, 1);
      // The stable service now runs the promoted image.
      const stable = s.services.find((sv) => sv.name === run.service || `${run.stack}_${sv.name}` === run.service);
      if (stable) stable.image = run.canaryImage;
      return { service: run.service, image: run.canaryImage };
    },

    'releases.abort': (i, s): CanaryAbortResult => {
      const b = i as { stack: string; service: string };
      const canaries = getCanaries(s);
      const idx = canaries.findIndex(
        (c) => c.stack === b.stack && (c.service === b.service || c.service === `${b.stack}_${b.service}`),
      );
      const run = canaries[idx];
      if (!run) throw new Error(`canary "${b.service}" not found`);
      canaries.splice(idx, 1);
      return { service: run.service };
    },
  },

  seed: (store) => {
    // Six releases across the demo stacks, newest first: one converging deploy,
    // a failed gate that auto-rolled back (and the rollback release that
    // followed it), plus healthy/superseded history for believable diffs.
    const state: ReleasesState = {
      safety: {
        storefront: { enabled: true, windowSec: 180, autoRollback: true },
        platform: { enabled: true, windowSec: 120, autoRollback: false },
      },
      releases: [
        {
          id: 'rel-store-6',
          stackName: 'storefront',
          status: 'deploying',
          images: [
            { name: 'web', image: 'ghcr.io/northwind/storefront-web:1.9.0' },
            { name: 'api', image: 'ghcr.io/northwind/storefront-api:1.9.0' },
            { name: 'worker', image: 'ghcr.io/northwind/storefront-worker:1.9.0' },
          ],
          actor: 'calum@gomacrae.com',
          strategy: { type: 'canary', trafficPct: 10, durationMin: 15 },
          healthGate: { windowSec: 180, autoRollback: true },
          notes: null,
          createdAt: iso(2 * MIN),
          composeSource: storefrontCompose('1.9.0', '1.9.0', 3),
        },
        {
          id: 'rel-plat-3',
          stackName: 'platform',
          status: 'healthy',
          images: [
            { name: 'gateway', image: 'ghcr.io/northwind/platform-gateway:0.42.1' },
            { name: 'cache', image: 'valkey/valkey:8' },
            { name: 'auth', image: 'ghcr.io/northwind/platform-auth:0.42.1' },
          ],
          actor: 'dee@northwind.dev',
          strategy: null,
          healthGate: { windowSec: 120, autoRollback: false },
          notes: null,
          createdAt: iso(3 * HOUR),
          composeSource: platformCompose('0.42.1', true),
        },
        {
          id: 'rel-store-5',
          stackName: 'storefront',
          status: 'healthy',
          images: [
            { name: 'web', image: 'ghcr.io/northwind/storefront-web:1.8.2' },
            { name: 'api', image: 'ghcr.io/northwind/storefront-api:1.8.1' },
            { name: 'worker', image: 'ghcr.io/northwind/storefront-worker:1.8.1' },
          ],
          actor: 'system',
          strategy: { type: 'canary', trafficPct: 10, durationMin: 15 },
          healthGate: { windowSec: 180, autoRollback: true },
          notes: 'Automatic rollback to release rel-store-3 (failed gate on rel-store-4)',
          createdAt: iso(26 * HOUR),
          composeSource: storefrontCompose('1.8.2', '1.8.1', 3),
        },
        {
          id: 'rel-store-4',
          stackName: 'storefront',
          status: 'rolled-back',
          images: [
            { name: 'web', image: 'ghcr.io/northwind/storefront-web:1.8.3' },
            { name: 'api', image: 'ghcr.io/northwind/storefront-api:1.8.3' },
            { name: 'worker', image: 'ghcr.io/northwind/storefront-worker:1.8.3' },
          ],
          actor: 'jamie@northwind.dev',
          strategy: { type: 'canary', trafficPct: 10, durationMin: 15 },
          healthGate: { windowSec: 180, autoRollback: true },
          notes: 'Health gate failed: api error rate 12% over 3m; 2/3 web tasks restarting',
          createdAt: iso(26 * HOUR + 20 * MIN),
          composeSource: storefrontCompose('1.8.3', '1.8.3', 2),
        },
        {
          id: 'rel-plat-2',
          stackName: 'platform',
          status: 'superseded',
          images: [
            { name: 'gateway', image: 'ghcr.io/northwind/platform-gateway:0.41.0' },
            { name: 'auth', image: 'ghcr.io/northwind/platform-auth:0.41.0' },
          ],
          actor: 'dee@northwind.dev',
          strategy: null,
          healthGate: null,
          notes: null,
          createdAt: iso(3 * 24 * HOUR),
          composeSource: platformCompose('0.41.0', false),
        },
        {
          id: 'rel-store-3',
          stackName: 'storefront',
          status: 'superseded',
          images: [
            { name: 'web', image: 'ghcr.io/northwind/storefront-web:1.8.2' },
            { name: 'api', image: 'ghcr.io/northwind/storefront-api:1.8.1' },
            { name: 'worker', image: 'ghcr.io/northwind/storefront-worker:1.8.1' },
          ],
          actor: 'calum@gomacrae.com',
          strategy: null,
          healthGate: { windowSec: 180, autoRollback: true },
          notes: null,
          createdAt: iso(4 * 24 * HOUR),
          composeSource: storefrontCompose('1.8.2', '1.8.1', 3),
        },
      ],
    };
    store.extra.releases = state;
  },
};
