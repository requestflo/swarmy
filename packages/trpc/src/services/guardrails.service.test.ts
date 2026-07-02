import { describe, expect, it } from 'bun:test';
import { GUARDRAIL_RULE_IDS } from '@swarmy/core';
import {
  coerceDecisionViolations,
  defaultGuardrailRules,
  encodeGuardrailRules,
  GUARDRAIL_DEFAULTS,
  parseGuardrailRules,
} from './guardrails.service';

describe('defaultGuardrailRules', () => {
  it('covers every rule id in display order with fresh param copies', () => {
    const a = defaultGuardrailRules();
    const b = defaultGuardrailRules();
    expect(a.map((r) => r.id)).toEqual([...GUARDRAIL_RULE_IDS]);
    a.find((r) => r.id === 'minDbReplicasProd')!.params.n = 99;
    expect(b.find((r) => r.id === 'minDbReplicasProd')!.params.n).toBe(2);
    expect(GUARDRAIL_DEFAULTS.minDbReplicasProd.params.n).toBe(2);
  });
});

describe('parseGuardrailRules — the rulesJson codec', () => {
  it('null / junk / non-array degrade to the full default set', () => {
    for (const raw of [null, undefined, 'junk', 42, { not: 'an array' }]) {
      const rules = parseGuardrailRules(raw);
      expect(rules).toEqual(defaultGuardrailRules());
    }
  });

  it('merges stored entries over defaults and drops unknown ids', () => {
    const rules = parseGuardrailRules([
      { id: 'noLatestTagInProd', enabled: false, severity: 'warn' },
      { id: 'minDbReplicasProd', params: { n: 3 } },
      { id: 'someFutureRule', enabled: true }, // unknown → dropped
      'garbage',
      null,
    ]);
    expect(rules.map((r) => r.id)).toEqual([...GUARDRAIL_RULE_IDS]);
    const latest = rules.find((r) => r.id === 'noLatestTagInProd')!;
    expect(latest.enabled).toBe(false);
    expect(latest.severity).toBe('warn');
    expect(latest.prodOnly).toBe(true); // derived, not storable
    expect(rules.find((r) => r.id === 'minDbReplicasProd')!.params.n).toBe(3);
    // untouched rule keeps its default
    expect(rules.find((r) => r.id === 'noPrivilegedContainers')!.enabled).toBe(true);
  });

  it('coerces bad field types back to defaults (never bricks the gate)', () => {
    const rules = parseGuardrailRules([
      { id: 'minDbReplicasProd', enabled: 'yes', severity: 'fatal', params: { n: 'two', m: 5 } },
    ]);
    const r = rules.find((x) => x.id === 'minDbReplicasProd')!;
    expect(r.enabled).toBe(true); // default
    expect(r.severity).toBe('block'); // default
    expect(r.params.n).toBe(2); // 'two' rejected → default kept
    expect(r.params.m).toBe(5); // extra numeric param allowed
  });

  it('round-trips through encodeGuardrailRules', () => {
    const edited = defaultGuardrailRules().map((r) =>
      r.id === 'requireHealthcheck' ? { ...r, enabled: true, severity: 'block' as const } : r,
    );
    expect(parseGuardrailRules(encodeGuardrailRules(edited))).toEqual(edited);
    // prodOnly is derived — it must not be persisted
    for (const e of encodeGuardrailRules(edited)) expect('prodOnly' in e).toBe(false);
  });
});

describe('coerceDecisionViolations — audit metadata → typed violations', () => {
  it('reads well-formed violations and defaults severity to block', () => {
    const v = coerceDecisionViolations({
      violations: [
        { rule: 'guardrails/no-latest-tag-in-prod', severity: 'block', message: 'm1', resource: 'web' },
        { rule: 'exposure/new-published-port', severity: 'warn', message: 'm2' },
        { rule: 'guardrails/x', severity: 'weird', message: 'm3' },
      ],
    });
    expect(v).toHaveLength(3);
    expect(v[0]).toEqual({
      rule: 'guardrails/no-latest-tag-in-prod',
      severity: 'block',
      message: 'm1',
      resource: 'web',
    });
    expect(v[1]!.severity).toBe('warn');
    expect(v[1]!.resource).toBeUndefined();
    expect(v[2]!.severity).toBe('block');
  });

  it('junk metadata degrades to an empty list', () => {
    expect(coerceDecisionViolations(null)).toEqual([]);
    expect(coerceDecisionViolations({})).toEqual([]);
    expect(coerceDecisionViolations({ violations: 'nope' })).toEqual([]);
    expect(coerceDecisionViolations({ violations: [{ rule: 1 }, null, 'x'] })).toEqual([]);
  });
});
