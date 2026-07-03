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
 * the signal catalog, two notification channels, and a live-feeling event feed
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
      target: 'oncall@acme.dev',
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
    const rules = ALERT_SIGNALS.map((signal) =>
      makeRule(signal, signal === 'node-offline' ? { channelIds: [email.id, slack.id] } : {}),
    );
    const ruleFor = (signal: AlertSignal): AlertRuleView | undefined =>
      rules.find((r) => r.signal === signal);

    const events: AlertEventView[] = [
      {
        id: id('evt'),
        ruleId: ruleFor('disk-usage')?.id ?? null,
        ruleName: 'Disk almost full',
        signal: 'disk-usage',
        severity: 'warning',
        resource: 'node:hetzner-worker-2',
        message: 'Disk on hetzner-worker-2 is 84.6% full (threshold 80%)',
        status: 'firing',
        firedAt: agoIso(42),
        resolvedAt: null,
      },
      {
        id: id('evt'),
        ruleId: ruleFor('queue-depth')?.id ?? null,
        ruleName: 'Queue backlog',
        signal: 'queue-depth',
        severity: 'warning',
        resource: 'queue:storefront_media-worker/image-resize',
        message: 'Queue image-resize has 1,412 waiting jobs (threshold 1,000)',
        status: 'firing',
        firedAt: agoIso(11),
        resolvedAt: null,
      },
      {
        id: id('evt'),
        ruleId: ruleFor('service-down')?.id ?? null,
        ruleName: 'Service down',
        signal: 'service-down',
        severity: 'critical',
        resource: 'service:checkout',
        message: 'Service checkout is running 0/2 replicas',
        status: 'resolved',
        firedAt: agoIso(60 * 5),
        resolvedAt: agoIso(60 * 5 - 6),
      },
      {
        id: id('evt'),
        ruleId: ruleFor('node-offline')?.id ?? null,
        ruleName: 'Node offline',
        signal: 'node-offline',
        severity: 'critical',
        resource: 'node:hetzner-worker-1',
        message: 'Node hetzner-worker-1 is offline',
        status: 'resolved',
        firedAt: agoIso(60 * 26),
        resolvedAt: agoIso(60 * 25),
      },
    ];

    store.extra.alerts = { channels: [email, slack], rules, events } satisfies AlertsState;
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
      if (rule.isDefault) throw new Error('default rules cannot be deleted — disable them instead');
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
        target:
          b.config.kind === 'email'
            ? b.config.to
            : (() => {
                try {
                  return new URL(b.config.url).host;
                } catch {
                  return 'invalid URL';
                }
              })(),
        hasSecret: b.config.kind === 'webhook' && Boolean(b.config.secret),
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
        ? { ok: true, detail: `queued email to ${channel.target}` }
        : { ok: true, detail: 'delivered (HTTP 200)' };
    },
  },
};
