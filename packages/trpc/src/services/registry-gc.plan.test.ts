import { describe, expect, it } from 'bun:test';
import { computeGcPlan, type GcCandidate, type GcMode } from './cicd.service';
import { floatingRepos, planRegistryGc, registryGcSignature, type UntaggedManifest } from './registry-gc.plan';

const D = (c: string) => `sha256:${c.repeat(64)}`;
const now = new Date('2026-10-24T12:00:00Z');
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);
const build = (c: string, d: number, repo = 'app'): GcCandidate => ({ buildId: `b${c}`, digest: D(c), finishedAt: daysAgo(d), repo });
const untagged = (c: string, d: number, repo = 'app'): UntaggedManifest => ({ repo, digest: D(c), modifiedAt: daysAgo(d) });

function plan(opts: {
  mode: GcMode;
  candidates: GcCandidate[];
  pinned?: string[];
  untagged?: UntaggedManifest[];
  keepProd?: boolean;
  floating?: string[];
}) {
  const pinnedDigests = new Set(opts.pinned ?? []);
  const gc = computeGcPlan({
    mode: opts.mode,
    days: 7,
    keepLast: 1,
    keepProd: opts.keepProd ?? true,
    pinnedDigests,
    candidates: opts.candidates,
    now,
  });
  return planRegistryGc({
    mode: opts.mode,
    plan: gc,
    candidates: opts.candidates,
    pinnedDigests,
    floatingRepos: new Set(opts.floating ?? []),
    untagged: opts.untagged ?? [],
    now,
  });
}

describe('planRegistryGc — never delete a digest a server could pull', () => {
  it('keep-last: deletes the policy-selected build, never the pinned one', () => {
    const out = plan({ mode: 'keep-last', candidates: [build('1', 30), build('2', 20), build('3', 2)], pinned: [`localhost:5000/app@${D('1')}`] });
    expect(out).toEqual([{ repo: 'app', digest: D('2'), reason: 'policy' }]);
  });

  it('keepProd:false never reaches the registry: the live pinned set still holds', () => {
    const out = plan({ mode: 'keep-last', keepProd: false, candidates: [build('1', 30), build('3', 2)], pinned: [D('1')] });
    expect(out).toEqual([]);
  });

  it('on-healthcheck keeps every build in the registry (rollback targets), sweeps untagged leftovers', () => {
    const out = plan({ mode: 'on-healthcheck', candidates: [build('1', 30), build('2', 20)], untagged: [untagged('c', 9)] });
    expect(out).toEqual([{ repo: 'app', digest: D('c'), reason: 'untagged' }]);
  });

  it('an untagged swarmy build is the policy’s call, never swept as a leftover', () => {
    // b2 is untagged (its `:main` tag moved on) but is the newest kept build.
    const out = plan({ mode: 'keep-last', candidates: [build('1', 30), build('2', 3)], untagged: [untagged('2', 3)] });
    expect(out.map((d) => d.digest)).toEqual([D('1')]);
  });

  it('an untagged manifest running in prod is never swept', () => {
    expect(plan({ mode: 'age-days', candidates: [], untagged: [untagged('e', 40)], pinned: [D('e')] })).toEqual([]);
  });

  it('nothing written inside the grace window is touched', () => {
    const out = plan({ mode: 'age-days', candidates: [build('1', 30)], untagged: [untagged('c', 0.5)] });
    expect(out.map((d) => d.digest)).toEqual([D('1')]);
    const fresh = plan({ mode: 'keep-last', candidates: [build('1', 0.2), build('2', 0.1)] });
    expect(fresh).toEqual([]); // b1 is policy-selected but finished 5h ago
  });

  it('a repo a service pulls by tag keeps all its builds', () => {
    const out = plan({ mode: 'keep-last', candidates: [build('1', 30), build('2', 2)], floating: ['app'] });
    expect(out).toEqual([]);
  });

  it('is capped and ordered deterministically; the signature is stable', () => {
    const many = Array.from({ length: 5 }, (_, i) => untagged(String.fromCharCode(97 + i), 10));
    const input = { mode: 'on-healthcheck' as const, plan: { remove: [], pinned: [], kept: [] }, candidates: [], pinnedDigests: new Set<string>(), floatingRepos: new Set<string>(), now };
    const a = planRegistryGc({ ...input, untagged: many, max: 3 });
    const b = planRegistryGc({ ...input, untagged: [...many].reverse(), max: 3 });
    expect(a).toHaveLength(3);
    expect(a).toEqual(b);
    expect(registryGcSignature(a)).toBe(registryGcSignature(b));
    expect(registryGcSignature([])).toBe('');
  });
});

describe('floatingRepos', () => {
  it('collects org-registry images referenced by tag only', () => {
    const isOrg = (i: string) => i.startsWith('localhost:5000/');
    const got = floatingRepos(['localhost:5000/app:main', `localhost:5000/api@${D('1')}`, 'nginx:1.27'], isOrg);
    expect([...got]).toEqual(['app']);
  });
});
