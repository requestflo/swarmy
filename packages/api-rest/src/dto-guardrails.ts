/**
 * Public DTOs for the org's guardrails (`/guardrails`): the production-safety
 * master switch and the deploy-admission rules. One per org (the key's).
 * "Production" itself is the `swarmy.env=production` Docker label on a
 * stack's services, never part of this config.
 */
import { z } from '@hono/zod-openapi';
import { GUARDRAIL_RULE_IDS } from '@swarmy/core';

export const GuardrailRuleIdDto = z.enum(GUARDRAIL_RULE_IDS).openapi('GuardrailRuleId', {
  description: 'A guardrail rule. Open enum: new rules may be added.',
});

const severity = z.enum(['block', 'warn']).openapi({
  description: '`block` refuses the deploy (an admin may override in the dashboard); `warn` asks for a confirmation.',
});
const params = z.record(z.number().int().min(0).max(1000)).openapi({
  description: 'Numeric rule parameters, e.g. `{ "n": 2 }` for minDbReplicasProd.',
});

export const GuardrailRuleDto = z
  .object({
    id: GuardrailRuleIdDto,
    enabled: z.boolean(),
    severity,
    params,
    prod_only: z.boolean().openapi({ description: 'Applies only to production stacks (`swarmy.env=production`).' }),
  })
  .openapi('GuardrailRule');

export const GuardrailsDto = z
  .object({
    org_id: z.string(),
    production_safety_mode: z.boolean().openapi({
      description: 'On: every rule is enforced at `block` on production stacks.',
    }),
    rules: z.array(GuardrailRuleDto),
  })
  .openapi('Guardrails');

export const GuardrailRuleUpdateDto = z
  .object({
    id: GuardrailRuleIdDto,
    enabled: z.boolean().optional(),
    severity: severity.optional(),
    params: params.optional().openapi({ description: 'Merged into the rule’s params (keys left out keep their value).' }),
  })
  .openapi('GuardrailRuleUpdate', { description: 'Fields left out keep their configured value.' });

export const UpdateGuardrailsBody = z
  .object({
    production_safety_mode: z.boolean().optional(),
    rules: z.array(GuardrailRuleUpdateDto).max(64).optional().openapi({
      description: 'Only the rules named change; the rest keep their state.',
    }),
  })
  .openapi('UpdateGuardrailsRequest', {
    description: 'Partial: what already holds is not rewritten (and writes no audit row).',
  });
