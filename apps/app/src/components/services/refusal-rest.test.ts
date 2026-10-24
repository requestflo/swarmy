import { describe, expect, it } from 'bun:test';
import { refusalExchange } from './refusal-rest';

const latest = { rule: 'guardrails/no-latest-tag-in-prod', severity: 'block' as const, message: 'pin a tag', resource: 'web' };
const port = { rule: 'exposure/new-published-port', severity: 'warn' as const, message: 'publishes 8080' };

describe('refusalExchange — the 412 a refused deploy gets over REST', () => {
  it('is a GuardrailProblem with the gate’s own detail and every violation', () => {
    const text = refusalExchange('/services', { violations: [latest, port], blocking: true });
    expect(text).toContain('HTTP/1.1 412 Precondition Failed');
    expect(text).toContain('Content-Type: application/problem+json');
    const body = JSON.parse(text.slice(text.indexOf('{')));
    expect(body).toEqual({
      type: 'https://swarmy.dev/problems/precondition_failed',
      title: 'Precondition Failed',
      status: 412,
      detail: 'Deployment blocked by policy:\n[block] guardrails/no-latest-tag-in-prod: pin a tag (web)\n[warn] exposure/new-published-port: publishes 8080',
      instance: '/api/v1/services',
      swarmy_code: 'POLICY_DENIED',
      violations: [latest, port],
    });
  });

  it('says how a warning-only refusal goes through', () => {
    const text = refusalExchange('/stacks', { violations: [port], blocking: false });
    expect(text).toContain('a warning is confirmed in the dashboard');
    expect(text).toContain('"instance": "/api/v1/stacks"');
  });
});
