import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { defaultGuardrailRules, encodeGuardrailRules } from './guardrails.service';
import { guardrailRuleChanges, updateGuardrails } from './guardrails-update';

const rule = defaultGuardrailRules().find((r) => r.id === 'minDbReplicasProd')!;

describe('guardrailRuleChanges', () => {
  it('is false for what already holds, true for any difference', () => {
    expect(guardrailRuleChanges(rule, { id: rule.id })).toBe(false);
    expect(guardrailRuleChanges(rule, { id: rule.id, enabled: true, severity: 'block', params: { n: 2 } })).toBe(false);
    expect(guardrailRuleChanges(rule, { id: rule.id, severity: 'warn' })).toBe(true);
    expect(guardrailRuleChanges(rule, { id: rule.id, params: { n: 3 } })).toBe(true);
  });
});

function ctxWith(row: { rulesJson: unknown; productionSafetyMode: boolean }, audit: string[]): OrgContext {
  return {
    activeOrgId: 'org1',
    user: { id: 'u1' },
    membership: { role: 'admin', orgId: 'org1' },
    db: {
      guardrailConfig: {
        upsert: async () => ({ ...row }),
        update: async ({ data }: { data: Partial<typeof row> }) => Object.assign(row, data),
      },
      auditLog: {
        create: async ({ data }: { data: { action: string } }) => {
          audit.push(data.action);
          return {};
        },
      },
    },
  } as unknown as OrgContext;
}

describe('updateGuardrails', () => {
  it('writes the switch and each changed rule once, through the audited mutations', async () => {
    const audit: string[] = [];
    const row = { rulesJson: encodeGuardrailRules(defaultGuardrailRules()), productionSafetyMode: false };
    const out = await updateGuardrails(ctxWith(row, audit), {
      productionSafetyMode: true,
      rules: [
        { id: 'noLatestTagInProd', enabled: true, severity: 'block' },
        { id: 'requireHealthcheck', enabled: true },
        { id: 'minDbReplicasProd', params: { n: 3 } },
      ],
    });
    expect(audit).toEqual(['guardrails.safetyMode.set', 'guardrails.rule.set', 'guardrails.rule.set']);
    expect(out.productionSafetyMode).toBe(true);
    expect(out.rules.find((r) => r.id === 'requireHealthcheck')).toMatchObject({ enabled: true, severity: 'warn' });
    expect(out.rules.find((r) => r.id === 'minDbReplicasProd')!.params).toEqual({ n: 3 });
  });

  it('a steady state writes nothing', async () => {
    const audit: string[] = [];
    const row = { rulesJson: encodeGuardrailRules(defaultGuardrailRules()), productionSafetyMode: true };
    await updateGuardrails(ctxWith(row, audit), { productionSafetyMode: true, rules: [{ id: 'noHostPortsProd', severity: 'warn' }] });
    expect(audit).toEqual([]);
  });
});
