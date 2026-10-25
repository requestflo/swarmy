import { z } from 'zod';

/**
 * The input of `policies.set` — one schema for both front doors, so REST
 * `POST/PUT /policies` accepts exactly what the dashboard's rules editor may
 * send. The policy document (`source`, JSON) is then compiled by
 * `setPolicy` itself, which refuses an invalid one, a rewrite of a managed
 * default, and an owner lockout.
 */
export const SetPolicyInput = z.object({
  id: z.string().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  effect: z.enum(['permit', 'forbid']),
  source: z.string().min(2),
  priority: z.number().int().min(0).max(1000).optional(),
  enabled: z.boolean().optional(),
});
export type SetPolicyInput = z.infer<typeof SetPolicyInput>;
