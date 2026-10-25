import { B, runCases } from './harness.js';

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
]);
