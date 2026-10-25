import { describe, expect, it } from 'bun:test';
import { GuardrailsDto } from '../dto-guardrails';
import { guardrailsPatch, guardrailsToDto } from '../mappers-guardrails';
import { testApp, type Role, type TestAppOptions } from '../test-kit';
import { memTable } from '../test-mem';

/**
 * /guardrails rides guardrails.service: GET is any member's `read` (it seeds
 * the default row), PATCH is admin-only `write` and goes through the audited
 * setSafetyMode / setRule, skipping what already holds.
 */

function setup(role: Role = 'admin', scopes: TestAppOptions['scopes'] = ['write']) {
  const guardrailConfig = memTable('gc');
  return { ...testApp({ role, scopes, models: { guardrailConfig } }), rows: guardrailConfig.rows };
}

describe('GET /guardrails', () => {
  it('seeds and returns the default config with the org id', async () => {
    const t = setup('member', ['read']);
    const r = await t.call('GET', '/guardrails');
    expect(r.status).toBe(200);
    expect(GuardrailsDto.safeParse(r.json).success).toBe(true);
    expect(r.json.org_id).toBe('org1');
    expect(r.json.production_safety_mode).toBe(false);
    expect(r.json.rules.find((x: { id: string }) => x.id === 'minDbReplicasProd')).toEqual({
      id: 'minDbReplicasProd', enabled: true, severity: 'block', params: { n: 2 }, prod_only: true,
    });
    expect(t.rows).toHaveLength(1);
  });
});

describe('PATCH /guardrails', () => {
  it('turns safety mode on and changes the named rules, audited once each', async () => {
    const t = setup();
    const r = await t.call('PATCH', '/guardrails', {
      production_safety_mode: true,
      rules: [{ id: 'requireHealthcheck', enabled: true, severity: 'block' }, { id: 'minDbReplicasProd', params: { n: 3 } }],
    });
    expect(r.status).toBe(200);
    expect(r.json.production_safety_mode).toBe(true);
    expect(r.json.rules.find((x: { id: string }) => x.id === 'requireHealthcheck')).toMatchObject({ enabled: true, severity: 'block' });
    expect(r.json.rules.find((x: { id: string }) => x.id === 'minDbReplicasProd').params).toEqual({ n: 3 });
    expect(t.actions()).toEqual(['guardrails.safetyMode.set', 'guardrails.rule.set', 'guardrails.rule.set']);

    const again = await t.call('PATCH', '/guardrails', { production_safety_mode: true, rules: [{ id: 'requireHealthcheck', enabled: true }] });
    expect(again.status).toBe(200);
    expect(t.actions()).toHaveLength(3);
  });

  it('refuses a member key (adminProcedure twin) and an unknown rule (400)', async () => {
    expect((await setup('member').call('PATCH', '/guardrails', { production_safety_mode: true })).status).toBe(403);
    expect((await setup().call('PATCH', '/guardrails', { rules: [{ id: 'noSuchRule' }] })).status).toBe(400);
    expect((await setup().call('PATCH', '/guardrails', { rules: [{ id: 'minDbReplicasProd', params: { n: 5000 } }] })).status).toBe(400);
  });
});

describe('guardrail mappers', () => {
  it('maps the view to snake_case and the body to the service patch', () => {
    expect(
      guardrailsToDto(
        { productionSafetyMode: true, rules: [{ id: 'noHostPortsProd', enabled: false, severity: 'warn', params: {}, prodOnly: true }] },
        'org9',
      ),
    ).toEqual({
      org_id: 'org9', production_safety_mode: true,
      rules: [{ id: 'noHostPortsProd', enabled: false, severity: 'warn', params: {}, prod_only: true }],
    });
    expect(guardrailsPatch({ rules: [{ id: 'noHostPortsProd', severity: 'block' }] })).toEqual({
      rules: [{ id: 'noHostPortsProd', severity: 'block' }],
    });
    expect(guardrailsPatch({})).toEqual({});
  });
});
