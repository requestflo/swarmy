/** ABAC policies: view → DTO, and the body → `policies.set`'s own input (same schema). */
import type { z } from '@hono/zod-openapi';
import { SetPolicyInput, type PolicyView } from '@swarmy/trpc';
import type { PolicyBody, PolicyDto } from './dto-policies';
import { parseWith } from './route-kit';

export function policyToDto(v: PolicyView): z.infer<typeof PolicyDto> {
  return {
    id: v.id,
    name: v.name,
    description: v.description,
    effect: v.effect,
    source: v.source,
    priority: v.priority,
    enabled: v.enabled,
    is_default: v.isDefault,
    sentence: v.sentence,
    updated_at: v.updatedAt.toISOString(),
  };
}

/** The tRPC `policies.set` input: `id` set = update that policy, unset = create. */
export function setPolicyInput(b: z.infer<typeof PolicyBody>, id?: string): SetPolicyInput {
  return parseWith(SetPolicyInput, { ...b, ...(id ? { id } : {}) });
}
