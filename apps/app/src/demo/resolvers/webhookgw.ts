import type {
  CreateInboundEndpointInput,
  InboundDeliveriesPage,
  InboundDeliveryDetailView,
  InboundDeliveryStatusView,
  InboundDeliveryView,
  InboundEndpointView,
  InboundWebhooksOverview,
  UpdateInboundEndpointInput,
} from '@swarmy/core';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * Inbound webhook gateway demo resolvers — the Webhooks surface (`/webhooks`):
 * endpoints, the deliveries feed, payload inspector, replay/dead letters, plus
 * the outbound (`webhooksOut.*`) tab. Return shapes mirror
 * `inboundWebhooks.service.ts` / `webhooks-out.service.ts` views exactly.
 * State lives in `store.extra.webhookgw`; replayed deliveries "deliver" a few
 * seconds later so the feed feels live under polling.
 */

/** Mirror of `WebhookEndpointView` (webhooks-out.service.ts). */
interface OutboundEndpointView {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  createdAt: string;
}

interface GwState {
  endpoints: InboundEndpointView[];
  /** Full detail per delivery; list handlers project the summary view. */
  deliveries: InboundDeliveryDetailView[];
  outbound: OutboundEndpointView[];
}

const DEMO_BASE = 'https://ctl.northwind.dev';
const ORG = 'org-demo';

const nowIso = (): string => new Date().toISOString();
const agoIso = (ms: number): string => new Date(Date.now() - ms).toISOString();
const rid = (prefix: string): string => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;

function getState(store: DemoStore): GwState {
  return store.extra.webhookgw as GwState;
}

function toSummary(d: InboundDeliveryDetailView): InboundDeliveryView {
  const { headers: _h, body: _b, ...summary } = d;
  return summary;
}

/** Pending deliveries "deliver" ~8s after they were (re)queued — feels live. */
function advancePending(st: GwState): void {
  for (const d of st.deliveries) {
    if (d.status !== 'pending' || !d.nextAttemptAt) continue;
    if (Date.now() - new Date(d.nextAttemptAt).getTime() > 8_000) {
      d.status = 'delivered';
      d.attempts += 1;
      d.lastError = null;
      d.nextAttemptAt = null;
    }
  }
}

function statsFor(st: GwState, endpointId: string): { deliveries24h: number; lastDeliveryAt: string | null } {
  const since = Date.now() - 24 * 3_600_000;
  const mine = st.deliveries.filter((d) => d.endpointId === endpointId);
  const recent = mine.filter((d) => new Date(d.receivedAt).getTime() >= since);
  const last = mine.map((d) => d.receivedAt).sort().at(-1) ?? null;
  return { deliveries24h: recent.length, lastDeliveryAt: last };
}

// ── seed payload builders ─────────────────────────────────────────────────────

function makeDelivery(
  ep: InboundEndpointView,
  opts: {
    ago: number;
    status: InboundDeliveryStatusView;
    verifyOk?: boolean;
    attempts?: number;
    lastError?: string | null;
    body: string;
    headers?: Record<string, string>;
  },
): InboundDeliveryDetailView {
  return {
    id: rid('idel'),
    endpointId: ep.id,
    endpointName: ep.name,
    endpointSlug: ep.slug,
    targetKind: ep.target.kind,
    receivedAt: agoIso(opts.ago),
    verifyOk: opts.verifyOk ?? true,
    status: opts.status,
    attempts: opts.attempts ?? (opts.status === 'delivered' ? 1 : 0),
    nextAttemptAt: opts.status === 'pending' ? agoIso(-45_000) : null,
    lastError: opts.lastError ?? null,
    bodyBytes: new TextEncoder().encode(opts.body).length,
    headers: {
      'content-type': 'application/json',
      'user-agent': 'demo-sender/1.0',
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  };
}

const STRIPE_BODY = JSON.stringify({
  id: 'evt_3Qx82KIcSx1JMxg',
  type: 'invoice.paid',
  created: 1735817420,
  data: { object: { id: 'in_1Qx82H', amount_paid: 4900, currency: 'usd', customer: 'cus_ROQvVeC' } },
});

const GITHUB_BODY = JSON.stringify({
  ref: 'refs/heads/main',
  after: '9f2c1ab84e7d3f0a5b6c',
  repository: { full_name: 'northwind/storefront' },
  pusher: { name: 'calum' },
  head_commit: { message: 'fix: checkout race on apply-coupon' },
});

const PARTNER_BODY = JSON.stringify({ event: 'inventory.sync', warehouse: 'eu-west-1', skus: 182 });

// ── resolvers ─────────────────────────────────────────────────────────────────

export const webhookgw: DomainResolvers = {
  handlers: {
    // ── inbound ──
    'inboundWebhooks.overview': (i, s): InboundWebhooksOverview => {
      const { stack } = (i ?? {}) as { stack?: string };
      const st = getState(s);
      advancePending(st);
      const eps = st.endpoints.filter((e) => (stack ? e.stackName === stack : true));
      const epIds = new Set(eps.map((e) => e.id));
      const deliveries = st.deliveries.filter((d) => epIds.has(d.endpointId));
      const since = Date.now() - 24 * 3_600_000;
      const recent = deliveries.filter((d) => new Date(d.receivedAt).getTime() >= since);
      return {
        endpoints: eps.length,
        deliveries24h: recent.length,
        failed24h: recent.filter((d) => d.status === 'failed' || d.status === 'dead').length,
        pending: deliveries.filter((d) => d.status === 'pending').length,
        dead: deliveries.filter((d) => d.status === 'dead').length,
      };
    },

    'inboundWebhooks.listEndpoints': (i, s): InboundEndpointView[] => {
      const { stack } = (i ?? {}) as { stack?: string };
      const st = getState(s);
      return st.endpoints
        .filter((e) => (stack ? e.stackName === stack : true))
        .map((e) => ({ ...e, ...statsFor(st, e.id) }));
    },

    'inboundWebhooks.createEndpoint': (i, s): InboundEndpointView => {
      const input = i as CreateInboundEndpointInput & {
        stackName?: string;
        domain?: string;
        transformTemplate?: string;
        responseTemplate?: string;
      };
      const st = getState(s);
      if (st.endpoints.some((e) => e.slug === input.slug)) {
        throw new Error(`slug "${input.slug}" is already taken in this org`);
      }
      const ep: InboundEndpointView = {
        id: rid('iep'),
        name: input.name,
        slug: input.slug,
        stackName: input.stackName ?? null,
        domain: input.domain || null,
        url: `${DEMO_BASE}/hooks/i/${ORG}/${input.slug}`,
        verifyKind: input.verifyKind ?? 'none',
        hasSecret: Boolean(input.secret),
        target: input.target,
        transformTemplate: input.transformTemplate || null,
        responseTemplate: input.responseTemplate || null,
        retentionDays: input.retentionDays ?? 30,
        deliveries24h: 0,
        lastDeliveryAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      st.endpoints = [ep, ...st.endpoints];
      return ep;
    },

    'inboundWebhooks.updateEndpoint': (i, s): InboundEndpointView => {
      const input = i as UpdateInboundEndpointInput & {
        domain?: string;
        transformTemplate?: string;
        responseTemplate?: string;
      };
      const st = getState(s);
      const ep = st.endpoints.find((e) => e.id === input.id);
      if (!ep) throw new Error('inbound endpoint not found');
      if (input.name !== undefined) ep.name = input.name;
      if (input.domain !== undefined) ep.domain = input.domain || null;
      if (input.verifyKind !== undefined) ep.verifyKind = input.verifyKind;
      if (input.secret) ep.hasSecret = true;
      if (input.verifyKind === 'none') ep.hasSecret = false;
      if (input.target !== undefined) ep.target = input.target;
      if (input.transformTemplate !== undefined) ep.transformTemplate = input.transformTemplate || null;
      if (input.responseTemplate !== undefined) ep.responseTemplate = input.responseTemplate || null;
      if (input.retentionDays !== undefined) ep.retentionDays = input.retentionDays;
      ep.updatedAt = nowIso();
      return { ...ep, ...statsFor(st, ep.id) };
    },

    'inboundWebhooks.removeEndpoint': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.endpoints = st.endpoints.filter((e) => e.id !== id);
      st.deliveries = st.deliveries.filter((d) => d.endpointId !== id);
      return { id, removed: true };
    },

    'inboundWebhooks.deliveries': (i, s): InboundDeliveriesPage => {
      const input = (i ?? {}) as {
        endpointId?: string;
        status?: InboundDeliveryStatusView;
        stack?: string;
        limit?: number;
      };
      const st = getState(s);
      advancePending(st);
      const limit = input.limit ?? 50;
      const stackEpIds = input.stack
        ? new Set(st.endpoints.filter((e) => e.stackName === input.stack).map((e) => e.id))
        : null;
      const rows = st.deliveries
        .filter((d) => (stackEpIds ? stackEpIds.has(d.endpointId) : true))
        .filter((d) => (input.endpointId ? d.endpointId === input.endpointId : true))
        .filter((d) => (input.status ? d.status === input.status : true))
        .sort((a, b) => (a.receivedAt < b.receivedAt ? 1 : -1));
      return {
        deliveries: rows.slice(0, limit).map(toSummary),
        nextCursor: rows.length > limit ? (rows[limit - 1]?.id ?? null) : null,
      };
    },

    'inboundWebhooks.delivery': (i, s): InboundDeliveryDetailView => {
      const { id } = i as { id: string };
      const d = getState(s).deliveries.find((x) => x.id === id);
      if (!d) throw new Error('delivery not found');
      return d;
    },

    'inboundWebhooks.replay': (i, s): InboundDeliveryView => {
      const { id } = i as { id: string };
      const d = getState(s).deliveries.find((x) => x.id === id);
      if (!d) throw new Error('delivery not found');
      if (!d.verifyOk) throw new Error('cannot replay a delivery that failed verification');
      d.status = 'pending';
      d.nextAttemptAt = nowIso();
      return toSummary(d);
    },

    'inboundWebhooks.pruneOld': (_i, s): { removed: number } => {
      const st = getState(s);
      let removed = 0;
      for (const ep of st.endpoints) {
        const cutoff = Date.now() - ep.retentionDays * 24 * 3_600_000;
        const before = st.deliveries.length;
        st.deliveries = st.deliveries.filter(
          (d) => d.endpointId !== ep.id || new Date(d.receivedAt).getTime() >= cutoff,
        );
        removed += before - st.deliveries.length;
      }
      return { removed };
    },

    // ── outbound (existing webhooksOut router) ──
    'webhooksOut.list': (_i, s): OutboundEndpointView[] => getState(s).outbound,

    'webhooksOut.register': (i, s): OutboundEndpointView & { secret: string } => {
      const input = i as { url: string; events: string[] };
      const st = getState(s);
      const ep: OutboundEndpointView = {
        id: rid('owh'),
        url: input.url,
        events: input.events,
        active: true,
        createdAt: nowIso(),
      };
      st.outbound = [ep, ...st.outbound];
      return { ...ep, secret: `whsec_${rid('demo')}${rid('x')}` };
    },

    'webhooksOut.setActive': (i, s): OutboundEndpointView => {
      const { id, active } = i as { id: string; active: boolean };
      const ep = getState(s).outbound.find((e) => e.id === id);
      if (!ep) throw new Error('webhook endpoint not found');
      ep.active = active;
      return ep;
    },

    'webhooksOut.remove': (i, s): { id: string; removed: true } => {
      const { id } = i as { id: string };
      const st = getState(s);
      st.outbound = st.outbound.filter((e) => e.id !== id);
      return { id, removed: true };
    },

    'webhooksOut.test': (_i, s): { enqueued: number; deliveryIds: string[] } => {
      const active = getState(s).outbound.filter((e) => e.active);
      return { enqueued: active.length, deliveryIds: active.map(() => rid('owd')) };
    },
  },

  seed: (store) => {
    // Three endpoints covering every verify kind + both targets, and a feed
    // with delivered / pending / rejected / dead rows so each badge, the
    // dead-letter filter and the replay path all render.
    const stripe: InboundEndpointView = {
      id: 'iep-stripe',
      name: 'Stripe production',
      slug: 'stripe-prod',
      stackName: 'storefront',
      domain: 'hooks.northwind.dev',
      url: `${DEMO_BASE}/hooks/i/${ORG}/stripe-prod`,
      verifyKind: 'stripe',
      hasSecret: true,
      target: { kind: 'queue', cacheCluster: 'storefront/main', queue: 'stripe-events', convention: 'bullmq' },
      transformTemplate: '{{json.data.object}}',
      responseTemplate: null,
      retentionDays: 30,
      deliveries24h: 0,
      lastDeliveryAt: null,
      createdAt: agoIso(21 * 24 * 3_600_000),
      updatedAt: agoIso(3 * 24 * 3_600_000),
    };
    const github: InboundEndpointView = {
      id: 'iep-github',
      name: 'GitHub → deploy hook',
      slug: 'github-deploys',
      stackName: 'platform',
      domain: null,
      url: `${DEMO_BASE}/hooks/i/${ORG}/github-deploys`,
      verifyKind: 'github',
      hasSecret: true,
      target: { kind: 'forward', url: 'https://ci.northwind.dev/hooks/github' },
      transformTemplate: null,
      responseTemplate: null,
      retentionDays: 14,
      deliveries24h: 0,
      lastDeliveryAt: null,
      createdAt: agoIso(40 * 24 * 3_600_000),
      updatedAt: agoIso(40 * 24 * 3_600_000),
    };
    const partner: InboundEndpointView = {
      id: 'iep-partner',
      name: 'Partner inventory sync',
      slug: 'partner-sync',
      stackName: 'storefront',
      domain: null,
      url: `${DEMO_BASE}/hooks/i/${ORG}/partner-sync`,
      verifyKind: 'hmac',
      hasSecret: true,
      target: { kind: 'queue', cacheCluster: 'storefront/main', queue: 'inventory', convention: 'list' },
      transformTemplate: null,
      responseTemplate: '{"received": "{{deliveryId}}"}',
      retentionDays: 7,
      deliveries24h: 0,
      lastDeliveryAt: null,
      createdAt: agoIso(9 * 24 * 3_600_000),
      updatedAt: agoIso(9 * 24 * 3_600_000),
    };

    const deliveries: InboundDeliveryDetailView[] = [
      makeDelivery(stripe, {
        ago: 4 * 60_000,
        status: 'delivered',
        body: STRIPE_BODY,
        headers: { 'stripe-signature': 't=1735817421,v1=6fd6a3e8c1b24f0e9a7d55c3b1a9e2f4d8c0b7a6e5f4d3c2b1a09f8e7d6c5b4a' },
      }),
      makeDelivery(stripe, {
        ago: 38 * 60_000,
        status: 'delivered',
        body: STRIPE_BODY.replace('invoice.paid', 'customer.subscription.updated'),
        headers: { 'stripe-signature': 't=1735815360,v1=2ab19c8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b' },
      }),
      makeDelivery(stripe, {
        ago: 2 * 60_000,
        status: 'pending',
        body: STRIPE_BODY.replace('invoice.paid', 'charge.refunded'),
        headers: { 'stripe-signature': 't=1735817580,v1=9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b2ab19c8d7e6f5a4b3c2d1e0f' },
      }),
      makeDelivery(stripe, {
        ago: 3 * 3_600_000,
        status: 'failed',
        verifyOk: false,
        attempts: 0,
        lastError: 'signature verification failed',
        body: '{"type":"invoice.paid","forged":true}',
        headers: { 'stripe-signature': 't=1735806000,v1=deadbeef' },
      }),
      makeDelivery(github, {
        ago: 26 * 60_000,
        status: 'delivered',
        body: GITHUB_BODY,
        headers: {
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=1f6f3c2b9d8e7a5c4b3a2d1e0f9c8b7a6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a',
        },
      }),
      makeDelivery(github, {
        ago: 7 * 3_600_000,
        status: 'dead',
        attempts: 6,
        lastError: 'HTTP 503',
        body: GITHUB_BODY.replace('main', 'release/v2'),
        headers: {
          'x-github-event': 'push',
          'x-hub-signature-256': 'sha256=0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b',
        },
      }),
      makeDelivery(partner, {
        ago: 12 * 60_000,
        status: 'delivered',
        body: PARTNER_BODY,
        headers: { 'x-signature': 'sha256=aa1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b' },
      }),
    ];
    // A retrying row: failed twice, next attempt still in the future — the feed
    // shows "pending" with the error and the inspector shows the retry time.
    const retrying = makeDelivery(partner, {
      ago: 95 * 60_000,
      status: 'pending',
      attempts: 2,
      lastError: 'cache cluster "storefront/main" not found',
      body: PARTNER_BODY.replace('182', '54'),
      headers: { 'x-signature': 'sha256=bb1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b' },
    });
    retrying.nextAttemptAt = agoIso(-11 * 60_000);
    deliveries.push(retrying);

    const outbound: OutboundEndpointView[] = [
      {
        id: 'owh-opsbot',
        url: 'https://ops.northwind.dev/hooks/swarmy',
        events: ['service.deployed', 'build.failed', 'alert.fired'],
        active: true,
        createdAt: agoIso(30 * 24 * 3_600_000),
      },
      {
        id: 'owh-audit',
        url: 'https://siem.northwind.dev/ingest/webhooks',
        events: ['*'],
        active: false,
        createdAt: agoIso(60 * 24 * 3_600_000),
      },
    ];

    store.extra.webhookgw = {
      endpoints: [stripe, github, partner],
      deliveries,
      outbound,
    } satisfies GwState;
  },
};
