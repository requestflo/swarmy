import type {
  GuardrailRuleView,
  GuardrailsConfigView,
  SetGuardrailRuleInput,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { getConfig, setRule, setSafetyMode } from './guardrails.service';

/**
 * The whole guardrail config in one write — the production-safety switch and
 * any number of rules — for the REST front door (and Terraform). It is the
 * dashboard's two mutations in sequence: `setSafetyMode` and `setRule` per
 * rule, each audited exactly as when clicked. What already holds is skipped,
 * so a steady-state apply writes (and audits) nothing.
 */

export interface GuardrailsPatch {
  productionSafetyMode?: boolean;
  rules?: SetGuardrailRuleInput[];
}

/** Pure: would `input` change `current` (enabled, severity or any named param)? */
export function guardrailRuleChanges(current: GuardrailRuleView, input: SetGuardrailRuleInput): boolean {
  if (input.enabled !== undefined && input.enabled !== current.enabled) return true;
  if (input.severity !== undefined && input.severity !== current.severity) return true;
  return Object.entries(input.params ?? {}).some(([k, v]) => current.params[k] !== v);
}

export async function updateGuardrails(ctx: OrgContext, patch: GuardrailsPatch): Promise<GuardrailsConfigView> {
  let config = await getConfig(ctx);
  if (patch.productionSafetyMode !== undefined && patch.productionSafetyMode !== config.productionSafetyMode) {
    config = await setSafetyMode(ctx, { enabled: patch.productionSafetyMode });
  }
  for (const input of patch.rules ?? []) {
    const current = config.rules.find((r) => r.id === input.id);
    if (current && !guardrailRuleChanges(current, input)) continue;
    config = await setRule(ctx, input);
  }
  return config;
}
