import type { PolicyRefusal } from './policy-refusal';

/**
 * The REST answer to a deploy the admission gate refuses: `412` with a
 * GuardrailProblem body (packages/api-rest problem.ts → trpcErrorToProblem),
 * exactly what POST /services and POST /stacks send for the same findings.
 * The detail is the admission gate's own message (admission-gate.ts).
 */
export function refusalExchange(path: '/services' | '/stacks', refusal: PolicyRefusal): string {
  const lines = refusal.violations.map((v) => `[${v.severity}] ${v.rule}: ${v.message}${v.resource ? ` (${v.resource})` : ''}`);
  const problem = {
    type: 'https://swarmy.dev/problems/precondition_failed',
    title: 'Precondition Failed',
    status: 412,
    detail: `Deployment blocked by policy:\n${lines.join('\n')}`,
    instance: `/api/v1${path}`,
    swarmy_code: 'POLICY_DENIED',
    violations: refusal.violations.map((v) => ({ rule: v.rule, severity: v.severity, message: v.message, ...(v.resource ? { resource: v.resource } : {}) })),
  };
  return [
    '# what this call answers while a guardrail stops it (the API never deploys past one:',
    refusal.blocking ? '# a block needs an admin or owner to override it in the dashboard)' : '# a warning is confirmed in the dashboard)',
    'HTTP/1.1 412 Precondition Failed',
    'Content-Type: application/problem+json',
    '',
    JSON.stringify(problem, null, 2),
  ].join('\n');
}
