/**
 * Public DTOs for ABAC policies (`/policies`). A policy is a permit or forbid
 * rule over a JSON document (`source`: roles, groups, actions, resource
 * types/labels, conditions, …); forbid wins, no permit means deny. The seeded
 * defaults are managed by swarmy: they can be switched off, never rewritten
 * or deleted.
 */
import { z } from '@hono/zod-openapi';
import { listEnvelope } from './dto';

const effect = z.enum(['permit', 'forbid']).openapi({ description: 'A matching forbid overrides every permit.' });

export const PolicyDto = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    effect,
    source: z.string().openapi({ description: 'The policy document, JSON.' }),
    priority: z.number().int().openapi({ description: 'Higher decides first (and names the deciding rule).' }),
    enabled: z.boolean(),
    is_default: z.boolean().openapi({ description: 'A seeded default: may be switched off, not rewritten or deleted.' }),
    sentence: z.string().openapi({ description: 'The rule in plain words.' }),
    updated_at: z.string(),
  })
  .openapi('Policy');

export const PolicyList = listEnvelope(PolicyDto, 'PolicyList');

export const PolicyBody = z
  .object({
    name: z.string().min(1).max(120),
    description: z.string().max(500).optional(),
    effect,
    source: z.string().min(2).openapi({
      description: 'The policy document as JSON, e.g. `{"roles":["member"],"actions":["service.restart"]}`. Validated before saving.',
    }),
    priority: z.number().int().min(0).max(1000).optional().openapi({ description: 'Default 0 on create; kept on update when left out.' }),
    enabled: z.boolean().optional().openapi({ description: 'Default true on create; kept on update when left out.' }),
  })
  .openapi('PolicyRequest', {
    description: 'The whole rule. On update, a description left out is cleared.',
  });
