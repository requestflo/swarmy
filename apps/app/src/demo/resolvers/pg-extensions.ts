import type { DemoStore, DomainResolvers } from '../types';

/**
 * `db.extensions` / `db.setExtension` demo resolvers (Postgres page, board 39).
 * Shapes mirror `manageddb-extensions-view.ts`. A toggle walks the same steps
 * the reconcile does, on a clock: standbys restart, the main copy restarts in
 * place, then CREATE EXTENSION — ~4 s each, so the page shows the rolling
 * restart. postgis is "needs a postgis image" (pgvector/pgvector:pg17 lacks it).
 */

type Name = 'pg_stat_statements' | 'postgis';
interface Toggle { name: Name; on: boolean; at: number }
interface ExtState { applied: Name[]; toggles: Record<string, Toggle | undefined> }

const STEP_MS = 4_000;
const IMAGE = 'pgvector/pgvector:pg17';

function state(s: DemoStore): ExtState {
  s.extra.pgExtensions ??= { applied: [], toggles: {} } satisfies ExtState;
  return s.extra.pgExtensions as ExtState;
}

function copiesOf(s: DemoStore, stack: string, cluster: string): number {
  const topo = (s.extra.data as { dbTopologies?: Array<{ stack: string; cluster: string; members: Array<{ role: string; desired?: number }> }> } | undefined)?.dbTopologies;
  const t = topo?.find((x) => x.stack === stack && x.cluster === cluster);
  return t ? Math.max(1, t.members.reduce((n, m) => n + (m.role === 'replica' ? (m.desired ?? 1) : m.role === 'primary' ? 1 : 0), 0)) : 2;
}

/** Where a toggle is now: the reconcile's step, or null once it has landed. */
function progressOf(t: Toggle | undefined, copies: number, now: number) {
  if (!t) return null;
  const restarts = t.name === 'pg_stat_statements';
  const steps = restarts
    ? [
        ...(t.on ? [] : [{ kind: 'drop' as const, phase: null }]),
        ...(copies > 1 ? [{ kind: 'restart' as const, phase: 'standby' as const }, { kind: 'verify' as const, phase: 'standby' as const }] : []),
        { kind: 'restart' as const, phase: 'writer' as const },
        ...(t.on ? [{ kind: 'verify' as const, phase: 'writer' as const }, { kind: 'create' as const, phase: null }] : []),
      ]
    : [{ kind: 'create' as const, phase: null }];
  const i = Math.floor((now - t.at) / STEP_MS);
  const step = steps[i];
  return step ? { ...step, services: [] as string[], reason: null } : null;
}

function view(s: DemoStore, stack: string, cluster: string) {
  const st = state(s);
  const key = `${stack}/${cluster}`;
  const copies = copiesOf(s, stack, cluster);
  const t = st.toggles[key];
  const progress = progressOf(t, copies, Date.now());
  if (t && !progress) {
    st.applied = t.on ? [...new Set([...st.applied, t.name])] : st.applied.filter((n) => n !== t.name);
    st.toggles[key] = undefined;
  }
  const live = st.toggles[key];
  const applied = (n: Name) => st.applied.includes(n);
  const wanted = (n: Name) => (live?.name === n ? live.on : applied(n));
  return {
    stack,
    cluster,
    image: IMAGE,
    copies,
    extensions: [
      { name: 'pg_stat_statements' as const, on: applied('pg_stat_statements'), wanted: wanted('pg_stat_statements'), available: true, restartsCopies: true, canDisable: true },
      { name: 'postgis' as const, on: false, wanted: false, available: false, restartsCopies: false, canDisable: false },
    ],
    progress: live ? progress : null,
    error: null,
  };
}

export const pgExtensions: DomainResolvers = {
  handlers: {
    'db.extensions': (i, s) => {
      const { stack, cluster } = i as { stack: string; cluster: string };
      return view(s, stack, cluster);
    },
    'db.setExtension': (i, s) => {
      const { stack, cluster, name, on } = i as { stack: string; cluster: string; name: Name; on: boolean };
      if (name === 'postgis') throw new Error(`postgis isn't in ${IMAGE}; it needs a postgis image (for example postgis/postgis:17-3.5)`);
      const st = state(s);
      const current = view(s, stack, cluster).extensions.find((x) => x.name === name)!;
      if (current.wanted === on) return { stack, cluster, name, on, changed: false, restartsCopies: true };
      st.toggles[`${stack}/${cluster}`] = { name, on, at: Date.now() };
      return { stack, cluster, name, on, changed: true, restartsCopies: true };
    },
  },
};
