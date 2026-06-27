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
