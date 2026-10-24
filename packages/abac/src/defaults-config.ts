import type { DefaultPolicySpec } from './defaults';

/**
 * Config-level deletes moved onto the policy gate (2026-10) without changing
 * who may do them. Members could already remove alert channels and rules,
 * status pages, scheduled jobs, inbound webhooks and AI keys/routes, so these
 * defaults keep exactly that. Outbound webhooks (`webhook.remove` on a
 * `webhookEndpoint`), backup schedules (`backup.remove`) and AI providers
 * (`secret.delete`) were admin-only and stay so: no member permit names them.
 *
 * The last role-gated deletes followed: members could always remove saved
 * studio queries (`savedquery.remove`), so they keep that; erasing RUM data
 * (`rum.remove`), revoking people's mesh access (`mesh.revoke`) and deleting a
 * moved volume's old copy (`data.destroy`) were admin-only and stay so.
 */
export const CONFIG_REMOVE_SPECS: DefaultPolicySpec[] = [
  {
    key: 'member-config-remove',
    name: 'Members can remove alerts, status pages, jobs and AI keys',
    effect: 'permit',
    priority: 35,
    doc: { roles: ['member'], actions: ['alert.remove', 'statuspage.remove', 'job.remove', 'ai.remove'] },
  },
  {
    key: 'member-inbound-webhook-remove',
    name: 'Members can remove inbound webhooks',
    effect: 'permit',
    priority: 34,
    doc: { roles: ['member'], actions: ['webhook.remove'], resourceTypes: ['inboundEndpoint'] },
  },
  {
    key: 'member-saved-query-remove',
    name: 'Members can remove saved queries',
    effect: 'permit',
    priority: 33,
    doc: { roles: ['member'], actions: ['savedquery.remove'] },
  },
];
