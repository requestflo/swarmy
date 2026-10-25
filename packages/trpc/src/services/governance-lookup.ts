import type { AlertRuleView, NotificationChannelView } from '@swarmy/core';
import type { OrgContext } from '../context';
import { notFound } from '../errors';
import { listChannels, listRules } from './alerts.service';
import { listPolicies, type PolicyView } from './policies.service';

/**
 * Read one governance/alerting row by id — what the dashboard gets by picking
 * it out of the list, as a call of its own for the REST front door (and its
 * Terraform reads). Each one goes through the SAME list function the tRPC
 * query uses, so the view, the seeding and the org wall are identical: a rule
 * the list hides (an opted-out default) or a row of another org is 404.
 */

export async function getAlertRule(ctx: OrgContext, id: string): Promise<AlertRuleView> {
  const rule = (await listRules(ctx)).find((r) => r.id === id);
  if (!rule) throw notFound('alert rule', id);
  return rule;
}

export async function getNotificationChannel(ctx: OrgContext, id: string): Promise<NotificationChannelView> {
  const channel = (await listChannels(ctx)).find((c) => c.id === id);
  if (!channel) throw notFound('notification channel', id);
  return channel;
}

export async function getPolicy(ctx: OrgContext, id: string): Promise<PolicyView> {
  const policy = (await listPolicies(ctx)).find((p) => p.id === id);
  if (!policy) throw notFound('policy', id);
  return policy;
}
