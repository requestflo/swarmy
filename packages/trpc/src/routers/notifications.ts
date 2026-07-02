import {
  NotifyDeliveriesInput,
  NotifyTemplateRefInput,
  NotifyTestSendInput,
  SaveNotifyTemplateInput,
  SetNotifyConfigInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  getConfig,
  listDeliveries,
  listTemplates,
  overview,
  removeTemplate,
  saveTemplate,
  setConfig,
  testSend,
} from '../services/notifications.service';

/**
 * Notifications (slice F6) — email provider config, templates, delivery log,
 * test send. Delivery itself happens in the `notification-dispatch` worker;
 * other slices enqueue via the `sendNotification` contract; apps use
 * `POST /api/v1/notify` (api-rest).
 */
export const notificationsRouter = router({
  /** Hero counts: configured?, queued, sent/failed/bounced (24h), templates. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  /** Provider config — redacted summary only; credentials never returned. */
  getConfig: orgProcedure.query(({ ctx }) => getConfig(ctx)),

  /** Save provider + from-address (creds vault-encrypted; audited). */
  setConfig: orgProcedure
    .input(SetNotifyConfigInput)
    .mutation(({ ctx, input }) => setConfig(ctx, input)),

  /** Queue a canned test email to prove the provider end-to-end (audited). */
  testSend: orgProcedure
    .input(NotifyTestSendInput)
    .mutation(({ ctx, input }) => testSend(ctx, input)),

  /** Every template, alphabetical. */
  listTemplates: orgProcedure.query(({ ctx }) => listTemplates(ctx)),

  /** Create (no id) or update (id set) a template (audited). */
  saveTemplate: orgProcedure
    .input(SaveNotifyTemplateInput)
    .mutation(({ ctx, input }) => saveTemplate(ctx, input)),

  /** Delete a template (audited). */
  removeTemplate: orgProcedure
    .input(NotifyTemplateRefInput)
    .mutation(({ ctx, input }) => removeTemplate(ctx, input.id)),

  /** Delivery log, newest first (status filter; cursor-paginated). */
  deliveries: orgProcedure
    .input(NotifyDeliveriesInput)
    .query(({ ctx, input }) => listDeliveries(ctx, input)),
});
