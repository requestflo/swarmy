/**
 * The governance and alerting services the REST front door rides
 * (`@swarmy/api-rest` routes alert-rules, notification-channels, guardrails,
 * policies, incidents, alert-events): the SAME functions the tRPC routers
 * call, re-exported from the package barrel under names that don't collide.
 */
export {
  createChannel as createNotificationChannel,
  createRule as createAlertRule,
  deleteChannel as deleteNotificationChannel,
  deleteRule as deleteAlertRule,
  listChannels as listNotificationChannels,
  listRules as listAlertRules,
  updateChannel as updateNotificationChannel,
  updateRule as updateAlertRule,
} from './services/alerts.service';
export { getAlertRule, getNotificationChannel } from './services/governance-lookup';
export { resolveConfigRow } from './abac-config';
