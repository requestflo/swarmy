import { describe, expect, it } from 'bun:test';
import { policyRefusal } from './policy-refusal';

const latest = { rule: 'guardrails/no-latest-tag-in-prod', severity: 'block', message: 'pin a tag', resource: 'web' };
const port = { rule: 'exposure/new-published-port', severity: 'warn', message: 'publishes 8080' };

describe('policyRefusal — when /services/new offers "Deploy anyway"', () => {
  it('reads a blocking refusal with its violations', () => {
    expect(policyRefusal({ data: { swarmyCode: 'POLICY_DENIED', violations: [latest, port] } })).toEqual({
      violations: [latest, port] as never,
      blocking: true,
    });
  });

  it('a warn-only refusal is not blocking', () => {
    expect(policyRefusal({ data: { swarmyCode: 'POLICY_DENIED', violations: [port] } })?.blocking).toBe(false);
  });

  it('keeps the panel up when the server asks for a reason', () => {
    expect(policyRefusal({ data: { swarmyCode: 'OVERRIDE_REASON_REQUIRED', violations: [latest] } })?.blocking).toBe(true);
  });

  it('ignores a plain policy deny, other errors and junk violations', () => {
    expect(policyRefusal({ data: { swarmyCode: 'POLICY_DENIED' } })).toBeNull();
    expect(policyRefusal({ data: { swarmyCode: 'NOT_FOUND', violations: [latest] } })).toBeNull();
    expect(policyRefusal({ data: { swarmyCode: 'POLICY_DENIED', violations: [null, { rule: 1 }, 'x'] } })).toBeNull();
    expect(policyRefusal(null)).toBeNull();
    expect(policyRefusal({ data: null })).toBeNull();
  });

  it('defaults an unknown severity to block (never under-warn)', () => {
    const r = policyRefusal({ data: { swarmyCode: 'POLICY_DENIED', violations: [{ ...port, severity: 'odd' }] } });
    expect(r?.violations[0]?.severity).toBe('block');
  });
});
