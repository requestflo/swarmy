/**
 * Demo build stages (mirror `BuildStageView` in packages/trpc/src/services/build-stages.ts):
 * clone → build → push from the builder, then scan · sign · roll out, derived
 * deterministically from each seeded build's start/finish so `/ci/$buildId`
 * shows board 27's stage rail with no backend. Rollouts land on the demo
 * `storefront` app's real parts (web 3/3, api 4/4).
 */

type Key = 'clone' | 'build' | 'push' | 'scan' | 'sign' | 'rollout';

export interface DemoStageView {
  key: Key;
  startedAt: string;
  finishedAt: string | null;
  outcome: 'running' | 'ok' | 'warn' | 'failed';
  facts: {
    error?: string;
    scan?: { critical: number; high: number; medium: number; low: number };
    rollout?: { stack: string; services: string[]; ready: number; desired: number; drained?: boolean };
  };
}

interface BuildBits {
  repoId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** Where each demo repo's builds roll out (repos without a part never deploy). */
const ROLLS_TO: Record<string, { service: string; copies: number }> = {
  'repo-web': { service: 'web', copies: 3 },
  'repo-api': { service: 'api', copies: 4 },
};

const iso = (ms: number): string => new Date(ms).toISOString();
const s = (key: Key, from: number, to: number | null, extra: Partial<DemoStageView> = {}): DemoStageView => ({
  key,
  startedAt: iso(from),
  finishedAt: to === null ? null : iso(to),
  outcome: to === null ? 'running' : 'ok',
  facts: {},
  ...extra,
});

export function demoStages(b: BuildBits, now = Date.now()): DemoStageView[] {
  if (!b.startedAt) return [];
  const t0 = Date.parse(b.startedAt);
  const clone = s('clone', t0, Math.min(t0 + 2_000, now));
  if (b.status === 'building' || b.status === 'queued' || b.status === 'pushing') {
    return now - t0 < 2_000 ? [{ ...clone, finishedAt: null, outcome: 'running' }] : [clone, s('build', t0 + 2_000, null)];
  }
  const end = b.finishedAt ? Date.parse(b.finishedAt) : t0 + 45_000;
  if (b.status === 'failed') {
    return [clone, s('build', t0 + 2_000, end, { outcome: 'failed', facts: { error: 'build exited 1' } })];
  }
  const out = [clone, s('build', t0 + 2_000, end - 3_000), s('push', end - 3_000, end)];
  out.push(s('scan', end + 1_000, end + 8_000, { facts: { scan: { critical: 0, high: 0, medium: 2, low: 5 } } }));
  out.push(s('sign', end + 8_000, end + 9_000));
  const to = ROLLS_TO[b.repoId];
  if (to) {
    const rollout = { stack: 'storefront', services: [to.service], ready: to.copies, desired: to.copies, drained: true };
    out.push(s('rollout', end + 1_000, end + 11_000, { facts: { rollout } }));
  }
  return out;
}

/** Median per stage over a repo's other successful demo builds (same rule as the server). */
export function demoUsualMs(builds: ReadonlyArray<BuildBits & { id: string }>, buildId: string): Partial<Record<Key, number>> {
  const me = builds.find((b) => b.id === buildId);
  const peers = builds.filter((b) => b.id !== buildId && b.repoId === me?.repoId && b.status === 'succeeded').slice(0, 20);
  const out: Partial<Record<Key, number>> = {};
  for (const key of ['clone', 'build', 'push', 'scan', 'sign', 'rollout'] as const) {
    const ms = peers
      .flatMap((b) => demoStages(b))
      .filter((x) => x.key === key && x.finishedAt)
      .map((x) => Date.parse(x.finishedAt!) - Date.parse(x.startedAt))
      .sort((a, z) => a - z);
    if (ms.length) out[key] = ms.length % 2 ? ms[(ms.length - 1) / 2]! : Math.round((ms[ms.length / 2 - 1]! + ms[ms.length / 2]!) / 2);
  }
  return out;
}
