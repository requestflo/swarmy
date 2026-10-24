import { describe, expect, test } from 'bun:test';
import type { AdmissionRuleTally, AdmissionTallyView, GuardrailRuleView } from '@swarmy/core';
import { ruleRecord } from './rule-history';

const rule = (over: Partial<GuardrailRuleView> = {}): GuardrailRuleView => ({
  id: 'requireHealthcheck', enabled: false, severity: 'warn', params: {}, prodOnly: false, ...over,
});
const tally = (rules: Array<Partial<AdmissionRuleTally> & { rule: string }>, capped = false): AdmissionTallyView => ({
  days: 30, since: '2026-09-24T00:00:00Z', capped,
  totals: { blocked: 0, warned: 0, overridden: 0, allowed: 0 },
  blockedBy: {},
  rules: rules.map((r) => ({ blocked: 0, warned: 0, overridden: 0, wouldBlock: 0, stacks: [], ...r })),
});
const health = 'guardrails/require-healthcheck';

describe('ruleRecord', () => {
  test('an Off rule says what Block would have stopped, and where', () => {
    expect(ruleRecord(rule(), false, tally([{ rule: health, wouldBlock: 3, stacks: ['blog', 'shop'] }]))).toEqual({
      line: 'On Block it would have stopped 3 deploys in 30 days: blog, shop.',
      tone: 'warn',
    });
  });

  test('a Warn rule with no record says nothing would have been stopped, never a fake count', () => {
    expect(ruleRecord(rule({ enabled: true }), false, tally([]))).toEqual({
      line: 'On Block it would have stopped nothing in 30 days.',
      tone: 'idle',
    });
  });

  test('a Warn rule also says how often it warned; a capped window is a floor', () => {
    const r = ruleRecord(rule({ enabled: true }), false, tally([{ rule: health, wouldBlock: 1, warned: 2, stacks: ['shop'] }], true));
    expect(r.line).toBe('On Block it would have stopped at least 1 deploy in 30 days: shop. It warned at least 2 times.');
  });

  test('a blocking rule says what it stopped and what went past it', () => {
    const r = ruleRecord(rule({ enabled: true, severity: 'block' }), false, tally([{ rule: health, blocked: 2, overridden: 1, stacks: ['shop'] }]));
    expect(r).toEqual({ line: 'Last 30 days it stopped 2 deploys and was overridden 1 time: shop.', tone: 'ok' });
    expect(ruleRecord(rule({ enabled: true, severity: 'block' }), false, tally([])).line).toBe('Last 30 days: nothing hit this rule.');
  });

  test('safety mode: a prod-only rule blocks wherever it applies; others add what production stopped', () => {
    const latest = rule({ id: 'noLatestTagInProd', prodOnly: true, enabled: false });
    expect(ruleRecord(latest, true, tally([{ rule: 'guardrails/no-latest-tag-in-prod', blocked: 1, stacks: ['shop'] }])).line).toBe(
      'Last 30 days it stopped 1 deploy: shop.',
    );
    expect(ruleRecord(rule(), true, tally([{ rule: health, blocked: 1, wouldBlock: 2, stacks: ['shop', 'blog'] }])).line).toBe(
      'On Block it would have stopped 2 deploys in 30 days: shop, blog. In production it stopped 1 deploy.',
    );
  });
});
