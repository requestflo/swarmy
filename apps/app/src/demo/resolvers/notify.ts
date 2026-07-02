import type { DemoStore, DomainResolvers } from '../types';

/**
 * Notifications demo resolvers — Settings · Notifications (`/settings/notifications`):
 * provider config, templates and the delivery log.
 *
 * Seeded world: a configured Resend provider with a from-address + bounce
 * endpoint, two templates, and a delivery history covering every status chip
 * (sent / queued / failed / bounced). Mutations mutate `store.extra.notify` so
 * saves, test sends and template edits feel live after invalidation.
 * Return shapes mirror the F6 views exactly (NotifyConfigView,
 * NotifyTemplateView, NotifyDeliveryView, NotifyOverview).
 */

// ───────────────────────────────────────────── controller view mirrors ──

type ProviderKind = 'smtp' | 'resend' | 'postmark' | 'mailgun';
type DeliveryStatus = 'queued' | 'sent' | 'failed' | 'bounced';

/** Mirror of `NotifyConfigView` (notifications.service.ts). */
interface ConfigView {
  provider: ProviderKind;
  fromAddress: string | null;
  configured: boolean;
  summary: Record<string, string>;
  bounceEndpointUrl: string | null;
  updatedAt: string | null;
}

/** Mirror of `NotifyTemplateView`. */
interface TemplateView {
  id: string;
  name: string;
  subject: string;
  bodyText: string | null;
  bodyHtml: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirror of `NotifyDeliveryView`. */
interface DeliveryView {
  id: string;
  to: string;
  subject: string | null;
  status: DeliveryStatus;
  providerId: string | null;
  error: string | null;
  attempts: number;
  template: string | null;
  createdAt: string;
}

// ───────────────────────────────────────────── demo world ──

interface NotifyState {
  config: ConfigView;
  templates: TemplateView[];
  deliveries: DeliveryView[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function agoIso(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function getState(store: DemoStore): NotifyState {
  return store.extra.notify as NotifyState;
}

const M = 60_000;
const H = 3_600_000;

const BOUNCE_URL = 'https://swarmy.northwind.dev/hooks/i/org-demo/notify-bounces-org-demo';

export const notify: DomainResolvers = {
  handlers: {
    'notifications.overview': (_i, s) => {
      const st = getState(s);
      const day = Date.now() - 24 * H;
      const in24h = (d: DeliveryView): boolean => new Date(d.createdAt).getTime() >= day;
      return {
        configured: st.config.configured,
        provider: st.config.configured ? st.config.provider : null,
        queued: st.deliveries.filter((d) => d.status === 'queued').length,
        sent24h: st.deliveries.filter((d) => d.status === 'sent' && in24h(d)).length,
        failed24h: st.deliveries.filter((d) => d.status === 'failed' && in24h(d)).length,
        bounced24h: st.deliveries.filter((d) => d.status === 'bounced' && in24h(d)).length,
        templates: st.templates.length,
      };
    },

    'notifications.getConfig': (_i, s): ConfigView => getState(s).config,

    'notifications.setConfig': (i, s): ConfigView => {
      const input = i as {
        provider: ProviderKind;
        fromAddress: string;
        smtp?: { host: string; port?: number; secure?: boolean; user?: string };
        mailgun?: { domain: string; baseUrl?: string };
      };
      const st = getState(s);
      const summary: Record<string, string> =
        input.provider === 'smtp' && input.smtp
          ? {
              host: input.smtp.host,
              port: String(input.smtp.port ?? 587),
              secure: input.smtp.secure ? 'tls' : 'starttls',
              ...(input.smtp.user ? { user: input.smtp.user } : {}),
            }
          : input.provider === 'mailgun' && input.mailgun
            ? { domain: input.mailgun.domain }
            : {};
      st.config = {
        provider: input.provider,
        fromAddress: input.fromAddress,
        configured: true,
        summary,
        bounceEndpointUrl: st.config.bounceEndpointUrl ?? `${BOUNCE_URL}`,
        updatedAt: nowIso(),
      };
      return st.config;
    },

    'notifications.testSend': (i, s) => {
      const { to } = i as { to: string };
      const st = getState(s);
      if (!st.config.configured) throw new Error('configure an email provider first');
      const d: DeliveryView = {
        id: rid('nd'),
        to,
        subject: 'swarmy test email',
        status: 'queued',
        providerId: null,
        error: null,
        attempts: 0,
        template: null,
        createdAt: nowIso(),
      };
      st.deliveries = [d, ...st.deliveries];
      // The dispatch worker "sends" it before the next poll lands.
      setTimeout(() => {
        d.status = 'sent';
        d.attempts = 1;
        d.providerId = rid('re');
      }, 2_500);
      return { queued: true as const, to, deliveryId: d.id };
    },

    'notifications.listTemplates': (_i, s): TemplateView[] =>
      [...getState(s).templates].sort((a, b) => a.name.localeCompare(b.name)),

    'notifications.saveTemplate': (i, s): TemplateView => {
      const input = i as {
        id?: string;
        name: string;
        subject: string;
        bodyText?: string;
        bodyHtml?: string;
      };
      const st = getState(s);
      const clash = st.templates.find((t) => t.name === input.name && t.id !== input.id);
      if (clash) throw new Error(`a template named "${input.name}" already exists`);
      if (input.id) {
        const t = st.templates.find((x) => x.id === input.id);
        if (!t) throw new Error('notification template not found');
        t.name = input.name;
        t.subject = input.subject;
        t.bodyText = input.bodyText?.length ? input.bodyText : null;
        t.bodyHtml = input.bodyHtml?.length ? input.bodyHtml : null;
        t.updatedAt = nowIso();
        return t;
      }
      const t: TemplateView = {
        id: rid('ntpl'),
        name: input.name,
        subject: input.subject,
        bodyText: input.bodyText?.length ? input.bodyText : null,
        bodyHtml: input.bodyHtml?.length ? input.bodyHtml : null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      st.templates = [...st.templates, t];
      return t;
    },

    'notifications.removeTemplate': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.templates = st.templates.filter((t) => t.id !== id);
      return { id, removed: true };
    },

    'notifications.deliveries': (i, s) => {
      const input = (i ?? {}) as { status?: DeliveryStatus; limit?: number; cursor?: string };
      const limit = input.limit ?? 50;
      const rows = getState(s)
        .deliveries.filter((d) => (input.status ? d.status === input.status : true))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
      return {
        deliveries: rows.slice(0, limit),
        nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
      };
    },
  },

  seed: (store) => {
    const templates: TemplateView[] = [
      {
        id: 'ntpl-alert',
        name: 'alert-fired',
        subject: 'Alert: {{signal}} on {{resource}}',
        bodyText: '{{signal}} fired on {{resource}}.\n\n{{message}}\n\n— swarmy',
        bodyHtml: '<h2>{{signal}}</h2><p><strong>{{resource}}</strong></p><p>{{message}}</p>',
        createdAt: agoIso(30 * 24 * H),
        updatedAt: agoIso(6 * 24 * H),
      },
      {
        id: 'ntpl-deploy',
        name: 'deploy-finished',
        subject: '{{stack}} deployed — {{status}}',
        bodyText: 'Stack {{stack}} finished deploying with status {{status}}.',
        bodyHtml: null,
        createdAt: agoIso(12 * 24 * H),
        updatedAt: agoIso(12 * 24 * H),
      },
    ];

    const deliveries: DeliveryView[] = [
      {
        id: 'nd-01',
        to: 'oncall@northwind.dev',
        subject: 'Alert: node-offline on hetzner-fsn-2',
        status: 'sent',
        providerId: 're-9f2c1ab4',
        error: null,
        attempts: 1,
        template: 'alert-fired',
        createdAt: agoIso(22 * M),
      },
      {
        id: 'nd-02',
        to: 'team@northwind.dev',
        subject: 'storefront deployed — healthy',
        status: 'sent',
        providerId: 're-77e0d215',
        error: null,
        attempts: 1,
        template: 'deploy-finished',
        createdAt: agoIso(2 * H),
      },
      {
        id: 'nd-03',
        to: 'cfo@northwind.dev',
        subject: 'Monthly cost digest',
        status: 'queued',
        providerId: null,
        error: null,
        attempts: 0,
        template: null,
        createdAt: agoIso(3 * M),
      },
      {
        id: 'nd-04',
        to: 'ex-employee@northwind.dev',
        subject: 'Alert: disk-usage on hetzner-fsn-1',
        status: 'bounced',
        providerId: 're-31bb90c7',
        error: 'mailbox does not exist',
        attempts: 1,
        template: 'alert-fired',
        createdAt: agoIso(5 * H),
      },
      {
        id: 'nd-05',
        to: 'oncall@northwind.dev',
        subject: 'Alert: error-rate on storefront/web',
        status: 'failed',
        providerId: null,
        error: 'HTTP 429: rate limit exceeded',
        attempts: 4,
        template: 'alert-fired',
        createdAt: agoIso(9 * H),
      },
      {
        id: 'nd-06',
        to: 'calum@gomacrae.com',
        subject: 'swarmy test email',
        status: 'sent',
        providerId: 're-c01dcafe',
        error: null,
        attempts: 1,
        template: null,
        createdAt: agoIso(26 * H),
      },
      {
        id: 'nd-07',
        to: 'team@northwind.dev',
        subject: 'Approval needed: workflow release-v42',
        status: 'sent',
        providerId: 're-5aa81f00',
        error: null,
        attempts: 2,
        template: null,
        createdAt: agoIso(2 * 24 * H),
      },
    ];

    const state: NotifyState = {
      config: {
        provider: 'resend',
        fromAddress: 'swarmy@northwind.dev',
        configured: true,
        summary: {},
        bounceEndpointUrl: BOUNCE_URL,
        updatedAt: agoIso(14 * 24 * H),
      },
      templates,
      deliveries,
    };
    store.extra.notify = state;
  },
};
