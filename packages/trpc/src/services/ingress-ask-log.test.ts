import { beforeEach, describe, expect, it } from 'bun:test';
import { ASK_LOG_MAX, _resetAskLog, askDecisions, recordAskDecision } from './ingress-ask-log';

describe('the ask log', () => {
  beforeEach(() => _resetAskLog());

  it('keeps each answer with its reason, newest first, for its own org only', () => {
    recordAskDecision({ host: 'shop.example.com', why: 'routed', orgId: 'org', app: 'shop' }, 1_000);
    recordAskDecision({ host: 'new.example.com', why: 'dns-pending', orgId: 'org' }, 2_000);
    recordAskDecision({ host: 'theirs.example.com', why: 'routed', orgId: 'other' }, 3_000);
    recordAskDecision({ host: 'evil.example.com', why: 'unknown', orgId: null }, 4_000);
    expect(askDecisions('org')).toEqual([
      { host: 'new.example.com', allowed: false, status: 403, why: 'dns-pending', app: null, at: new Date(2_000).toISOString(), count: 1 },
      { host: 'shop.example.com', allowed: true, status: 200, why: 'routed', app: 'shop', at: new Date(1_000).toISOString(), count: 1 },
    ]);
  });

  it('counts a repeat and moves it to the top, so a flood can’t bury an answer', () => {
    recordAskDecision({ host: 'a.example.com', why: 'unknown', orgId: 'org' }, 1_000);
    recordAskDecision({ host: 'b.example.com', why: 'routed', orgId: 'org' }, 2_000);
    for (let i = 0; i < 500; i++) recordAskDecision({ host: 'a.example.com', why: 'unknown', orgId: 'org' }, 3_000 + i);
    const log = askDecisions('org');
    expect(log.map((r) => [r.host, r.count])).toEqual([
      ['a.example.com', 501],
      ['b.example.com', 1],
    ]);
  });

  it('a different answer for the same host is its own row', () => {
    recordAskDecision({ host: 'new.example.com', why: 'dns-pending', orgId: 'org' }, 1_000);
    recordAskDecision({ host: 'new.example.com', why: 'routed', orgId: 'org' }, 2_000);
    expect(askDecisions('org').map((r) => r.why)).toEqual(['routed', 'dns-pending']);
  });

  it('is bounded', () => {
    for (let i = 0; i < ASK_LOG_MAX + 40; i++) recordAskDecision({ host: `h${i}.example.com`, why: 'unknown', orgId: 'org' }, i);
    expect(askDecisions('org', 1_000)).toHaveLength(ASK_LOG_MAX);
    expect(askDecisions('org')).toHaveLength(50);
  });
});
