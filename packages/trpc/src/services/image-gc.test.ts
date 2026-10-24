import { describe, expect, it } from 'bun:test';
import { bareDigest, computeGcPlan, type GcCandidate } from './cicd.service';

const PROD = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const OLD = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const RECENT = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';

function cand(digest: string, finishedAt: Date): GcCandidate {
  return { buildId: `b-${digest.slice(7, 13)}`, digest, finishedAt };
}

describe('computeGcPlan — never prune the in-prod digest', () => {
  const now = new Date('2026-06-27T12:00:00.000Z');
  const longAgo = new Date('2026-01-01T00:00:00.000Z'); // ~6 months old
  const yesterday = new Date('2026-06-26T12:00:00.000Z');

  it('AGE_DAYS: keeps an old digest if it is pinned in prod', () => {
    const plan = computeGcPlan({
      mode: 'age-days',
      days: 14,
      keepProd: true,
      pinnedDigests: new Set([PROD]),
      candidates: [cand(PROD, longAgo), cand(OLD, longAgo), cand(RECENT, yesterday)],
      now,
    });
    expect(plan.remove).toContain(OLD); // old + not pinned → removed
    expect(plan.remove).not.toContain(PROD); // old BUT pinned → kept
    expect(plan.remove).not.toContain(RECENT); // recent → kept
    expect(plan.pinned).toContain(PROD);
  });

  it('ON_HEALTHCHECK: prunes every non-pinned digest, never the pinned one', () => {
    const plan = computeGcPlan({
      mode: 'on-healthcheck',
      days: null,
      keepProd: true,
      pinnedDigests: new Set([PROD]),
      candidates: [cand(PROD, yesterday), cand(OLD, yesterday), cand(RECENT, yesterday)],
      now,
    });
    expect(plan.remove.sort()).toEqual([OLD, RECENT].sort());
    expect(plan.remove).not.toContain(PROD);
  });

  it('matches a pinned digest given as a full repo@sha256 ref', () => {
    const plan = computeGcPlan({
      mode: 'on-healthcheck',
      days: null,
      keepProd: true,
      pinnedDigests: new Set([`registry:5000/app@${PROD}`]),
      candidates: [cand(PROD, yesterday), cand(OLD, yesterday)],
      now,
    });
    expect(plan.remove).toEqual([OLD]);
    expect(plan.remove).not.toContain(PROD);
  });

  it('keepProd:false disables pinning (explicit hobby-box opt-out)', () => {
    const plan = computeGcPlan({
      mode: 'on-healthcheck',
      days: null,
      keepProd: false,
      pinnedDigests: new Set([PROD]),
      candidates: [cand(PROD, yesterday), cand(OLD, yesterday)],
      now,
    });
    expect(plan.remove.sort()).toEqual([OLD, PROD].sort());
    expect(plan.pinned).toEqual([]);
  });

  it('KEEP_LAST: keeps the newest N per repo plus a pinned old digest', () => {
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const D = (c: string) => `sha256:${c.repeat(64)}`;
    const plan = computeGcPlan({
      mode: 'keep-last',
      days: null,
      keepLast: 2,
      keepProd: true,
      pinnedDigests: new Set([`localhost:5000/api@${D('1')}`]), // oldest api build runs in prod
      candidates: [
        { ...cand(D('1'), at(30)), repo: 'api' },
        { ...cand(D('2'), at(20)), repo: 'api' },
        { ...cand(D('3'), at(10)), repo: 'api' },
        { ...cand(D('4'), at(1)), repo: 'api' },
        { ...cand(D('5'), at(40)), repo: 'web' }, // web's only build: newest of its repo
      ],
      now,
    });
    expect(plan.remove).toEqual([D('2')]);
    expect(plan.remove).not.toContain(D('1')); // old BUT pinned → kept
    expect(plan.kept.sort()).toEqual([D('3'), D('4'), D('5')].sort());
    expect(plan.pinned).toContain(D('1'));
  });

  it('KEEP_LAST: a pinned digest is never removed even with N=1 and many newer builds', () => {
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const plan = computeGcPlan({
      mode: 'keep-last',
      days: null,
      keepLast: 1,
      keepProd: true,
      pinnedDigests: new Set([PROD]),
      candidates: [cand(PROD, at(90)), cand(OLD, at(5)), cand(RECENT, at(1))],
      now,
    });
    expect(plan.remove).toEqual([OLD]);
    expect(plan.remove).not.toContain(PROD);
  });

  it('KEEP_LAST: a digest kept in one repo is never removed for being old in another', () => {
    const at = (d: number) => new Date(now.getTime() - d * 86_400_000);
    const plan = computeGcPlan({
      mode: 'keep-last',
      days: null,
      keepLast: 1,
      keepProd: true,
      pinnedDigests: new Set(),
      candidates: [
        { ...cand(OLD, at(1)), repo: 'a' },
        { ...cand(RECENT, at(0.5)), repo: 'b' },
        { ...cand(OLD, at(1)), repo: 'b' },
      ],
      now,
    });
    expect(plan.remove).toEqual([]);
  });

  it('KEEP_LAST without a count removes nothing (never guesses a window)', () => {
    const plan = computeGcPlan({
      mode: 'keep-last',
      days: null,
      keepLast: null,
      keepProd: true,
      pinnedDigests: new Set(),
      candidates: [cand(OLD, longAgo), cand(RECENT, yesterday)],
      now,
    });
    expect(plan.remove).toEqual([]);
  });

  it('KEEP_LAST + keepProd:false is still the only way a pinned digest can go', () => {
    const plan = computeGcPlan({
      mode: 'keep-last',
      days: null,
      keepLast: 1,
      keepProd: false,
      pinnedDigests: new Set([PROD]),
      candidates: [cand(PROD, longAgo), cand(RECENT, yesterday)],
      now,
    });
    expect(plan.remove).toEqual([PROD]);
    expect(plan.pinned).toEqual([]);
  });

  it('AGE_DAYS: a recent non-pinned digest is never removed', () => {
    const plan = computeGcPlan({
      mode: 'age-days',
      days: 30,
      keepProd: true,
      pinnedDigests: new Set(),
      candidates: [cand(RECENT, yesterday)],
      now,
    });
    expect(plan.remove).toEqual([]);
  });
});

describe('bareDigest', () => {
  it('strips a repo@ prefix', () => {
    expect(bareDigest(`registry:5000/app@${PROD}`)).toBe(PROD);
  });
  it('passes a bare digest through', () => {
    expect(bareDigest(PROD)).toBe(PROD);
  });
});
