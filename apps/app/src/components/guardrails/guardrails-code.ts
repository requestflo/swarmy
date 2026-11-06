import type { GuardrailsConfigView, StackEnvView } from '@swarmy/core';
import { curl, tfResource, withHeader, type CodeTab, type Hcl } from '@/components/calm';

/**
 * Code depth for Guardrails: the config as it stands, as the real calls —
 * `PATCH /guardrails` (openapi.json; the key's creator must be an admin or
 * owner) and Terraform's one-per-org `swarmy_guardrails`. Which apps count as
 * production is the `swarmy.env` label, set on this page; it has no REST
 * route, so it stays read-only.
 */
export function guardrailsCode(c: GuardrailsConfigView, envs: StackEnvView[]): CodeTab[] {
  const rules = c.rules.map((r) => ({
    id: r.id,
    enabled: r.enabled,
    severity: r.severity,
    ...(Object.keys(r.params).length > 0 ? { params: { ...r.params } } : {}),
  }));

  const rest = [
    '# Set the guardrails to what this page shows (rules left out keep their value):',
    curl('PATCH', '/guardrails', { production_safety_mode: c.productionSafetyMode, rules }),
    '',
    '# Read them back:',
    curl('GET', '/guardrails'),
  ].join('\n');

  const map: Record<string, Hcl> = {};
  for (const { id, ...fields } of rules) map[id] = fields;
  const terraform = [
    '# One per workspace. Only the rules named here are managed; the others keep',
    '# what the dashboard set. Destroying it leaves the guardrails as last applied.',
    tfResource('swarmy_guardrails', 'org', { production_safety_mode: c.productionSafetyMode, rules: map }),
    '',
    '# Adopt the current guardrails (the ID is the workspace id):',
    '#   terraform import swarmy_guardrails.org <org_id>',
  ].join('\n');

  const labels =
    envs.map((s) => `${s.stack.padEnd(18)} ${s.production ? 'swarmy.env=production' : '(no swarmy.env)'}`).join('\n') || '# no apps yet';

  return [
    { label: 'curl', code: rest },
    { label: 'Terraform', code: terraform },
    { label: 'labels', code: withHeader('Read-only: production is the swarmy.env label, set on this page.', labels) },
  ];
}
