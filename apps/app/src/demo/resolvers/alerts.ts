import type {
  AlertEventView,
  AlertRuleView,
  AlertSignal,
  AlertsOverview,
  ChannelConfigInput,
  ChannelTestResult,
  NotificationChannelView,
} from '@swarmy/core';
import { ALERT_SIGNALS, ALERT_SIGNAL_INFO } from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Alerting demo resolvers — the Alerts surface (`/alerts`): rules seeded from
 * the signal catalog plus one custom rule, three notification channels, and a live-feeling event feed
 * (two firing, a few resolved). Shapes mirror alerts.service.ts views exactly
 * (imported from @swarmy/core, never redeclared). State lives in
 * `store.extra.alerts`; mutations rewrite it so invalidation re-renders.
 */

interface AlertsState {
  channels: NotificationChannelView[];
  rules: AlertRuleView[];
  events: AlertEventView[];
}

const nowIso = (): string => new Date().toISOString();
const agoIso = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
let seq = 0;
const id = (prefix: string): string => `demo-${prefix}-${++seq}`;

const getState = (store: DemoStore): AlertsState => store.extra.alerts as AlertsState;

function makeRule(signal: AlertSignal, over: Partial<AlertRuleView> = {}): AlertRuleView {
  const info = ALERT_SIGNAL_INFO[signal];
  return {
    id: id('rule'),
    name: info.label,
    signal,
    threshold: info.defaultThreshold,
    forSeconds: info.defaultForSeconds,
    channelIds: [],
    enabled: true,
    isDefault: true,
    createdAt: agoIso(60 * 24 * 14),
    ...over,
  };
}

export const alerts: DomainResolvers = {
  seed: (store) => {
    const email: NotificationChannelView = {
      id: id('ch'),
      name: 'On-call email',
      kind: 'email',
      enabled: true,
      target: 'oncall@northwind.dev',
      hasSecret: false,
      createdAt: agoIso(60 * 24 * 30),
    };
    const slack: NotificationChannelView = {
      id: id('ch'),
      name: '#ops Slack',
      kind: 'slack',
      enabled: true,
      target: 'hooks.slack.com',
      hasSecret: false,
      createdAt: agoIso(60 * 24 * 21),
    };
    const phones: NotificationChannelView = {
      id: id('ch'),
      name: 'ntfy · phones',
      kind: 'ntfy',
      enabled: true,
      target: 'ntfy.northwind.dev/ops',
      hasSecret: true,
      createdAt: agoIso(60 * 24 * 9),
    };
    const rules = ALERT_SIGNALS.map((signal) =>
      makeRule(signal, signal === 'node-offline' ? { channelIds: [email.id, slack.id, phones.id] } : {}),
    );
    // One custom rule: it takes over from the built-in error-rate one (the
    // oldest custom rule for a signal wins, as in alerts-fire `matchRule`).
    const appErrors = makeRule('error-rate', {
      name: 'App errors',
      threshold: 5,
      forSeconds: 300,
      channelIds: [slack.id],
      isDefault: false,
      createdAt: agoIso(60 * 24 * 10),
    });
    rules.push(appErrors);
    const ruleFor = (signal: AlertSignal): AlertRuleView | undefined =>
      rules.find((r) => r.signal === signal && !r.isDefault) ?? rules.find((r) => r.signal === signal);
    const ev = (
      signal: AlertSignal,
      resource: string,
      message: string,
      firedMin: number,
      lastedMin: number | null,
      severity: AlertEventView['severity'] = ALERT_SIGNAL_INFO[signal].severity,
    ): AlertEventView => ({
      id: id('evt'),
      ruleId: ruleFor(signal)?.id ?? null,
      ruleName: ruleFor(signal)?.name ?? null,
      signal,
      severity,
      resource,
      message,
      status: lastedMin === null ? 'firing' : 'resolved',
      firedAt: agoIso(firedMin),
      resolvedAt: lastedMin === null ? null : agoIso(firedMin - lastedMin),
    });
    const H = 60;
    const D = 24 * H;

    // One story with Overview and Incidents: the storefront 1.9.0 rollout left
    // checkout a copy short (incident inc-deploy-storefront, opened 1 min ago),
    // and checkout's error rate is 6.2% (the demo service map). Checkout errors
    // also fired twice earlier this week, so "Fired 3× this week" is the feed.
    const events: AlertEventView[] = [
      ev('error-rate', 'service:checkout', 'Error rate on checkout is 6.2% over 5m (41/662 spans, threshold 5%)', 18, null),
      ev('service-down', 'service:checkout', 'checkout is running 1 of 2 copies', 1, null),
      ev('error-rate', 'service:checkout', 'Error rate on checkout is 7.9% over 5m (58/734 spans, threshold 5%)', 2 * D + 5 * H, 26),
      ev('error-rate', 'service:api', 'Error rate on api is 5.4% over 5m (37/690 spans, threshold 5%)', 5 * D + 9 * H, 12),
      ev('service-down', 'service:checkout', 'checkout was running 0 of 2 copies', 5 * H, 6, 'critical'),
      ev('node-offline', 'node:wkr-3', 'Server wkr-3 is offline', 26 * H, 60),
      ev('disk-usage', 'node:wkr-1', 'The disk on server wkr-1 is 86.3% full (threshold 85%)', 4 * D, 3 * H),
      ev('backup-failed', 'backup:data_pgdata', 'Last backup of volume data_pgdata failed: repository is already locked', 6 * D + 3 * H, 9 * H),
    ];

    store.extra.alerts = { channels: [email, slack, phones], rules, events } satisfies AlertsState;
  },

  handlers: {
    'alerts.overview': (_i, s): AlertsOverview => {
      const st = getState(s);
      const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const firing = st.events.filter((e) => e.status === 'firing');
      return {
        firing: firing.length,
        firingCritical: firing.filter((e) => e.severity === 'critical').length,
        resolved24h: st.events.filter(
          (e) => e.status === 'resolved' && e.resolvedAt !== null && Date.parse(e.resolvedAt) >= dayAgo,
        ).length,
        rules: st.rules.length,
        rulesEnabled: st.rules.filter((r) => r.enabled).length,
        channels: st.channels.length,
      };
    },

    'alerts.events': (i, s): AlertEventView[] => {
      const { status, limit } = (i ?? {}) as { status?: 'firing' | 'resolved'; limit?: number };
      return getState(s)
        .events.filter((e) => (status ? e.status === status : true))
        .sort((a, b) => Date.parse(b.firedAt) - Date.parse(a.firedAt))
        .slice(0, limit ?? 50);
    },

    'alerts.ack': (i, s): AlertEventView => {
      const { id: eventId } = i as { id: string };
      const event = getState(s).events.find((e) => e.id === eventId);
      if (!event) throw new Error('alert event not found');
      event.status = 'resolved';
      event.resolvedAt = nowIso();
      return event;
    },

    'alerts.rules': (_i, s): AlertRuleView[] =>
      [...getState(s).rules].sort(
        (a, b) => Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name),
      ),

    'alerts.createRule': (i, s): AlertRuleView => {
      const b = i as {
        name: string;
        signal: AlertSignal;
        threshold?: number | null;
        forSeconds?: number;
        channelIds?: string[];
        enabled?: boolean;
      };
      const rule = makeRule(b.signal, {
        name: b.name,
        threshold: b.threshold ?? null,
        forSeconds: b.forSeconds ?? 0,
        channelIds: b.channelIds ?? [],
        enabled: b.enabled ?? true,
        isDefault: false,
        createdAt: nowIso(),
      });
      getState(s).rules.push(rule);
      return rule;
    },

    'alerts.updateRule': (i, s): AlertRuleView => {
      const b = i as {
        id: string;
        name?: string;
        threshold?: number | null;
        forSeconds?: number;
        channelIds?: string[];
        enabled?: boolean;
      };
      const rule = getState(s).rules.find((r) => r.id === b.id);
      if (!rule) throw new Error('alert rule not found');
      if (b.name !== undefined) rule.name = b.name;
      if (b.threshold !== undefined) rule.threshold = b.threshold;
      if (b.forSeconds !== undefined) rule.forSeconds = b.forSeconds;
      if (b.channelIds !== undefined) rule.channelIds = b.channelIds;
      if (b.enabled !== undefined) rule.enabled = b.enabled;
      return rule;
    },

    'alerts.deleteRule': (i, s): { removed: true } => {
      const { id: ruleId } = i as { id: string };
      const st = getState(s);
      const rule = st.rules.find((r) => r.id === ruleId);
      if (!rule) throw new Error('alert rule not found');
      // Defaults are opt-out tombstoned server-side; the demo simply drops them.
      st.rules = st.rules.filter((r) => r.id !== ruleId);
      return { removed: true };
    },

    'alerts.channels': (_i, s): NotificationChannelView[] => getState(s).channels,

    'alerts.createChannel': (i, s): NotificationChannelView => {
      const b = i as { name: string; config: ChannelConfigInput };
      const channel: NotificationChannelView = {
        id: id('ch'),
        name: b.name,
        kind: b.config.kind,
        enabled: true,
        target: demoChannelTarget(b.config),
        hasSecret:
          (b.config.kind === 'webhook' && Boolean(b.config.secret)) ||
          (b.config.kind === 'ntfy' && Boolean(b.config.token)) ||
          b.config.kind === 'telegram' ||
          b.config.kind === 'gotify',
        createdAt: nowIso(),
      };
      getState(s).channels.push(channel);
      return channel;
    },

    'alerts.updateChannel': (i, s): NotificationChannelView => {
      const b = i as { id: string; name?: string; enabled?: boolean };
      const channel = getState(s).channels.find((c) => c.id === b.id);
      if (!channel) throw new Error('notification channel not found');
      if (b.name !== undefined) channel.name = b.name;
      if (b.enabled !== undefined) channel.enabled = b.enabled;
      return channel;
    },

    'alerts.deleteChannel': (i, s): { removed: true } => {
      const { id: channelId } = i as { id: string };
      const st = getState(s);
      if (!st.channels.some((c) => c.id === channelId)) throw new Error('channel not found');
      st.channels = st.channels.filter((c) => c.id !== channelId);
      return { removed: true };
    },

    'alerts.testChannel': (i, s): ChannelTestResult => {
      const { id: channelId } = i as { id: string };
      const channel = getState(s).channels.find((c) => c.id === channelId);
      if (!channel) throw new Error('channel not found');
      return channel.kind === 'email'
        ? { ok: true, detail: 'handed to the mail server' }
        : { ok: true, detail: 'delivered (HTTP 200)' };
    },
  },
};

/** Mirror of the controller's redacted `channelTarget` (alerts-channels.ts). */
function demoChannelTarget(config: ChannelConfigInput): string {
  if (config.kind === 'email') return config.to;
  if (config.kind === 'telegram') return `chat ${config.chatId}`;
  const raw = config.kind === 'ntfy' || config.kind === 'gotify' ? config.server : config.url;
  try {
    const host = new URL(raw).host;
    return config.kind === 'ntfy' ? `${host}/${config.topic}` : host;
  } catch {
    return 'invalid URL';
  }
}
