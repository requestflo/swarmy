import { describe, expect, it } from 'bun:test';
import { draftProblem, dropSentence, funnelId, funnelTitle, moveStep, spikeIssue, type FunnelView, type IssueRow } from './funnel-model';

const H = 3_600_000;
const ago = (h: number): string => new Date(Date.now() - h * H).toISOString();

function issue(over: Partial<IssueRow>): IssueRow {
  return { fingerprint: 'f1', title: 'TypeError', status: 'unresolved', count24h: 50, firstSeen: ago(0.2), regressedAt: null, ...over } as IssueRow;
}

const VIEW = {
  biggestDrop: { index: 2, from: 'checkout', to: 'paid', dropOff: 0.4, lost: 40 },
  since: { releaseId: 'r6', image: 'ghcr.io/northwind/storefront-web:1.9.0', at: ago(0.5), before: 0.6, after: 0.3 },
} as FunnelView;

describe('the drop sentence', () => {
  it('names the drop, and the release only when the read found one', () => {
    expect(dropSentence(VIEW)).toEqual({ drop: 'Biggest drop: checkout → paid', since: 'v1.9.0' });
    expect(dropSentence({ ...VIEW, since: null })).toEqual({ drop: 'Biggest drop: checkout → paid', since: null });
    expect(dropSentence({ ...VIEW, biggestDrop: null })).toBeNull();
  });
});

describe('See the error', () => {
  it('picks the busiest unresolved issue that started or came back since that release', () => {
    const issues = [
      issue({ fingerprint: 'old', firstSeen: ago(30), count24h: 300 }),
      issue({ fingerprint: 'quiet', count24h: 4 }),
      issue({ fingerprint: 'ignored', status: 'ignored', count24h: 500 }),
      issue({ fingerprint: 'back', firstSeen: ago(90), regressedAt: ago(0.1), count24h: 40 }),
      issue({ fingerprint: 'pay', count24h: 96 }),
    ];
    expect(spikeIssue(issues, VIEW.since!.at)?.fingerprint).toBe('pay');
    expect(spikeIssue(issues.slice(0, 4), VIEW.since!.at)?.fingerprint).toBe('back');
  });
  it('without a release to tie it to, there is no link', () => {
    expect(spikeIssue([issue({})], null)).toBeNull();
  });
});

describe('editing funnels', () => {
  it('ids are slugs, unique among the saved ones', () => {
    expect(funnelId('Checkout', [])).toBe('checkout');
    expect(funnelId('Checkout', ['checkout', 'checkout-2'])).toBe('checkout-3');
    expect(funnelId('  Sign up → paid!', [])).toBe('sign-up-paid');
    expect(funnelId('→', [])).toBe('funnel');
  });
  it('steps move one place, never off the ends', () => {
    expect(moveStep(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moveStep(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveStep(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
  it('says why a draft cannot be saved', () => {
    const ok = { id: 'c', name: 'Checkout', steps: [{ path: '/cart' }, { path: '/paid/*', event: 'paid' }] };
    expect(draftProblem(ok)).toBeNull();
    expect(draftProblem({ ...ok, name: ' ' })).toBe('Give the funnel a name.');
    expect(draftProblem({ ...ok, steps: [{ path: '/cart' }] })).toContain('at least 2');
    expect(draftProblem({ ...ok, steps: [{ path: 'cart' }, { path: '/b' }] })).toContain('Step 1');
    expect(draftProblem({ ...ok, steps: [{ path: '/a' }, { path: '/b', event: 'no<' }] })).toContain('Step 2');
  });
  it('titles read as a funnel once', () => {
    expect(funnelTitle('Checkout')).toBe('Checkout funnel');
    expect(funnelTitle('Signup funnel')).toBe('Signup funnel');
  });
});
