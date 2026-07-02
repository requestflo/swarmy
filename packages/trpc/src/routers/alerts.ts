import {
  AckAlertEventInput,
  AlertEventsInput,
  AlertRuleRefInput,
  ChannelRefInput,
  CreateAlertRuleInput,
  CreateChannelInput,
  UpdateAlertRuleInput,
  UpdateChannelInput,
} from '@swarmy/core';
import { orgProcedure, router } from '../trpc';
import {
  ackEvent,
  createChannel,
  createRule,
  deleteChannel,
  deleteRule,
  listChannels,
  listEvents,
  listRules,
  overview,
  testChannel,
  updateChannel,
  updateRule,
} from '../services/alerts.service';

/**
 * Alerting (slice C3) — notification channels, alert rules and the
 * firing/resolved event feed. Channel destinations are vault-encrypted and
 * never returned; events are raised by the alert-evaluator worker (and other
 * slices) through `alerts-fire.ts`.
 */
export const alertsRouter = router({
  /** Aggregates for the Alerts hero + the shell bell badge. */
  overview: orgProcedure.query(({ ctx }) => overview(ctx)),

  // ── Channels ────────────────────────────────────────────────────────────────
  /** Notification channels (redacted targets only). */
  channels: orgProcedure.query(({ ctx }) => listChannels(ctx)),
  /** Add a channel (email / slack / teams / webhook). Config is encrypted at rest. */
  createChannel: orgProcedure
    .input(CreateChannelInput)
    .mutation(({ ctx, input }) => createChannel(ctx, input)),
  /** Rename / enable / repoint a channel. */
  updateChannel: orgProcedure
    .input(UpdateChannelInput)
    .mutation(({ ctx, input }) => updateChannel(ctx, input)),
  /** Remove a channel. */
  deleteChannel: orgProcedure
    .input(ChannelRefInput)
    .mutation(({ ctx, input }) => deleteChannel(ctx, input)),
  /** Send a test message through the channel and report the outcome. */
  testChannel: orgProcedure
    .input(ChannelRefInput)
    .mutation(({ ctx, input }) => testChannel(ctx, input)),

  // ── Rules ───────────────────────────────────────────────────────────────────
  /** All rules; seeds the per-signal defaults on first call. */
  rules: orgProcedure.query(({ ctx }) => listRules(ctx)),
  /** Add a custom rule for a known signal. */
  createRule: orgProcedure
    .input(CreateAlertRuleInput)
    .mutation(({ ctx, input }) => createRule(ctx, input)),
  /** Edit threshold / for-duration / channel bindings / enabled. */
  updateRule: orgProcedure
    .input(UpdateAlertRuleInput)
    .mutation(({ ctx, input }) => updateRule(ctx, input)),
  /** Remove a custom rule (defaults can only be disabled). */
  deleteRule: orgProcedure
    .input(AlertRuleRefInput)
    .mutation(({ ctx, input }) => deleteRule(ctx, input)),

  // ── Events ──────────────────────────────────────────────────────────────────
  /** The event feed, newest first, optionally filtered to firing/resolved. */
  events: orgProcedure.input(AlertEventsInput).query(({ ctx, input }) => listEvents(ctx, input)),
  /** Acknowledge (manually resolve) one firing event. */
  ack: orgProcedure.input(AckAlertEventInput).mutation(({ ctx, input }) => ackEvent(ctx, input)),
});
