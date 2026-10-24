import { describe, expect, it } from 'bun:test';
import type { GuardrailRuleId, GuardrailsConfigView } from '@swarmy/core';
import type { GuardrailEstateFacts } from './admission-guardrails';
import type { GuardrailSpecFacts } from './admission-guardrails-specs';
import { decideWouldBlock, shadowRules } from './admission-guardrails-shadow';
import { defaultGuardrailRules } from './guardrails.service';

/** Defaults with some rules re-levelled: `[id, 'block' | 'warn' | 'off']`. */
function config(levels: Array<[GuardrailRuleId, 'block' | 'warn' | 'off']> = [], safety = false): GuardrailsConfigView {
  const by = new Map(levels);
  return {
    productionSafetyMode: safety,
    rules: defaultGuardrailRules().map((r) => {
      const l = by.get(r.id);
      return l === undefined ? r : l === 'off' ? { ...r, enabled: false } : { ...r, enabled: true, severity: l };
    }),
  };
}

const spec = (over: Partial<GuardrailSpecFacts> = {}): GuardrailSpecFacts => ({
  name: 'web', image: 'ghcr.io/acme/web:1.4.2', labels: {}, hostPorts: [], hasHealthcheck: true, hasMemoryLimit: true, privileged: false, ...over,
});
const estate = (over: Partial<GuardrailEstateFacts> = {}): GuardrailEstateFacts => ({ dbClusters: [], hasOrgBackupSchedules: false, signingEnforced: true, ...over });
const levels = (m: ReturnType<typeof shadowRules>) => Object.fromEntries([...m].map(([id, s]) => [id, s.level]));

describe('shadowRules: what is Warn or Off here, re-armed at Block', () => {
  it('defaults outside production: the off hygiene rules, never the prod-only ones', () => {
    const m = shadowRules(config(), false);
    expect(levels(m)).toEqual({ requireBackupPolicy: 'off', requireHealthcheck: 'off', requireResourceLimits: 'off' });
    for (const s of m.values()) expect(s.rule.severity).toBe('block');
  });

  it('defaults in production add the prod-only Warn and Off rules, keeping params', () => {
    const m = shadowRules(config([['minDbReplicasProd', 'warn']]), true);
    expect(levels(m)).toEqual({
      minDbReplicasProd: 'warn', requireBackupPolicy: 'off', requireHealthcheck: 'off',
      requireResourceLimits: 'off', requireSignedImagesProd: 'off', noHostPortsProd: 'warn',
    });
    expect(m.get('minDbReplicasProd')?.rule).toEqual({ severity: 'block', params: { n: 2 } });
  });

  it('safety mode already blocks everything in production: nothing to imagine there', () => {
    expect(shadowRules(config([], true), true).size).toBe(0);
    expect(levels(shadowRules(config([], true), false))).toEqual(levels(shadowRules(config(), false)));
  });
});

describe('decideWouldBlock: the same decision core, one hit per rule', () => {
  const decide = (specs: GuardrailSpecFacts[], over: { isProd?: boolean; estate?: GuardrailEstateFacts; cfg?: GuardrailsConfigView } = {}) =>
    decideWouldBlock({ shadow: shadowRules(over.cfg ?? config(), over.isProd ?? false), isProd: over.isProd ?? false, stackName: 'shop', specs, estate: over.estate ?? estate() });

  it('a tidy spec would pass every rule at Block', () => {
    expect(decide([spec()], { isProd: true })).toEqual([]);
  });

  it('merges every service a rule names into one hit', () => {
    expect(decide([spec({ hasHealthcheck: false }), spec({ name: 'api', hasHealthcheck: false, hasMemoryLimit: false })])).toEqual([
      { rule: 'guardrails/require-healthcheck', level: 'off', resources: ['web', 'api'] },
      { rule: 'guardrails/require-resource-limits', level: 'off', resources: ['api'] },
    ]);
  });

  it('a Warn rule is listed at its level; estate facts decide db and signing rules', () => {
    const hits = decide([spec({ hostPorts: [8080] })], {
      isProd: true,
      estate: estate({ dbClusters: [{ cluster: 'main', declaredReplicas: 0, hasBackupSchedule: false }], signingEnforced: false }),
    });
    expect(hits.map((h) => [h.rule, h.level])).toEqual([
      ['guardrails/require-backup-policy', 'off'],
      ['guardrails/require-signed-images-prod', 'off'],
      ['guardrails/no-host-ports-prod', 'warn'],
    ]);
  });

  it('a rule already at Block is never a would-block hit (it really blocks)', () => {
    const cfg = config([['requireHealthcheck', 'block']]);
    expect(decide([spec({ hasHealthcheck: false })], { cfg })).toEqual([]);
  });
});
