import type { ResolveResource } from './abac';

/**
 * Resolver for a config row the policy sees by TYPE: alert channels and rules,
 * status pages, webhook endpoints, scheduled jobs, backup schedules, AI keys,
 * routes and providers. The type matches the row's audit `targetType`; the id
 * is read from `input[key]`.
 *
 * These rows carry no Docker labels (no env), so type + id is the whole
 * resource: enough for a type-scoped rule (`resourceTypes: ['inboundEndpoint']`),
 * a ResourceGrant on that row, and an audit row that names the target. No
 * attribute the row holds could change the decision, so there is no lookup
 * here: the org wall and existence stay in the service, whose org-scoped
 * `findFirst` runs right after the gate and 404s an unknown id.
 */
export function resolveConfigRow(type: string, key = 'id'): ResolveResource {
  return (ctx, input) => {
    const id = (input as Record<string, unknown> | null | undefined)?.[key];
    return typeof id === 'string' && id ? { type, id, orgId: ctx.activeOrgId, labels: {} } : null;
  };
}
