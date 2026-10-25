import { B, list, runCases } from './harness.js';

const source = JSON.stringify({ roles: ['member'], actions: ['service.restart'] });
const policyBody = { name: 'Members restart', effect: 'permit' as const, source };
const policy = {
  id: 'p 1', ...policyBody, description: null, priority: 0, enabled: true, is_default: false,
  sentence: 'Members can restart', updated_at: '2026-10-01T00:00:00.000Z',
};

const guardrails = {
  org_id: 'org1', production_safety_mode: true,
  rules: [{ id: 'minDbReplicasProd', enabled: true, severity: 'block', params: { n: 3 }, prod_only: true }],
};

runCases('guardrails and policies', [
  { name: 'guardrails.get', call: (c) => c.guardrails.get(), response: guardrails,
    request: `GET ${B}/guardrails`, check: (o) => o.rules[0].params.n, want: 3 },
  { name: 'guardrails.update',
    call: (c) => c.guardrails.update({ production_safety_mode: false, rules: [{ id: 'requireHealthcheck', enabled: true }] }),
    response: { ...guardrails, production_safety_mode: false }, request: `PATCH ${B}/guardrails`,
    body: { production_safety_mode: false, rules: [{ id: 'requireHealthcheck', enabled: true }] },
    check: (o) => o.production_safety_mode, want: false },

  { name: 'policies.list', call: (c) => c.policies.list(), response: list([policy]),
    request: `GET ${B}/policies`, check: (o) => o.data[0].effect, want: 'permit' },
  { name: 'policies.get', call: (c) => c.policies.get('p 1'), response: policy,
    request: `GET ${B}/policies/p%201`, check: (o) => o.sentence, want: 'Members can restart' },
  { name: 'policies.create', call: (c) => c.policies.create(policyBody), response: policy, status: 201,
    request: `POST ${B}/policies`, body: policyBody, check: (o) => o.is_default, want: false },
  { name: 'policies.replace', call: (c) => c.policies.replace('p1', { ...policyBody, enabled: false }),
    response: { ...policy, enabled: false }, request: `PUT ${B}/policies/p1`, body: { ...policyBody, enabled: false },
    check: (o) => o.enabled, want: false },
  { name: 'policies.remove', call: (c) => c.policies.remove('p1'), response: { id: 'p1', removed: true },
    request: `DELETE ${B}/policies/p1`, check: (o) => o.removed, want: true },
]);
