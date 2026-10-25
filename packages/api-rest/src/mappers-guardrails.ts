/** Guardrails: view → DTO, and the PATCH body → the service's patch (core-schema checked). */
import type { z } from '@hono/zod-openapi';
import {
  SetGuardrailRuleInput,
  SetGuardrailSafetyModeInput,
  type GuardrailsConfigView,
} from '@swarmy/core';
import type { GuardrailsPatch } from '@swarmy/trpc';
import type { GuardrailsDto, UpdateGuardrailsBody } from './dto-guardrails';
import { parseWith } from './route-kit';

export function guardrailsToDto(v: GuardrailsConfigView, orgId: string): z.infer<typeof GuardrailsDto> {
  return {
    org_id: orgId,
    production_safety_mode: v.productionSafetyMode,
    rules: v.rules.map((r) => ({
      id: r.id,
      enabled: r.enabled,
      severity: r.severity,
      params: { ...r.params },
      prod_only: r.prodOnly,
    })),
  };
}

export function guardrailsPatch(b: z.infer<typeof UpdateGuardrailsBody>): GuardrailsPatch {
  const patch: GuardrailsPatch = {};
  if (b.production_safety_mode !== undefined) {
    patch.productionSafetyMode = parseWith(SetGuardrailSafetyModeInput, { enabled: b.production_safety_mode }).enabled;
  }
  if (b.rules) patch.rules = b.rules.map((r) => parseWith(SetGuardrailRuleInput, r));
  return patch;
}
