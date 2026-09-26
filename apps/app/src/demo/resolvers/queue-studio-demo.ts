import type { DomainResolvers } from '../types';

/**
 * Demo Queue Studio (`queues.studio*`): storefront's `main` queue cache holds
 * four BullMQ queues with believable counts, a page of jobs per state, and one
 * failed job with its error and attempts, so the studio has something to show.
 */
const MIN = 60_000;
const t = (msAgo: number): string => String(Date.now() - msAgo);

export interface DemoQ {
  name: string;
  wait: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  perMin: number;
}
/** storefront's queues on `main` — the one list the messaging tab (queues.ts) and the studio both read. */
export const STOREFRONT_QUEUES: DemoQ[] = [
  { name: 'emails', wait: 38, active: 2, delayed: 1, completed: 18_420, failed: 0, perMin: 42 },
  { name: 'image-resize', wait: 412, active: 6, delayed: 0, completed: 51_880, failed: 37, perMin: 120 },
  { name: 'webhooks', wait: 0, active: 1, delayed: 4, completed: 8_211, failed: 12, perMin: 18 },
  { name: 'abandoned-carts', wait: 0, active: 0, delayed: 211, completed: 2_040, failed: 1, perMin: 3 },
];

const JOB_NAMES: Record<string, string[]> = {
  emails: ['order.confirmation', 'password.reset', 'shipping.update'],
  'image-resize': ['product.thumbnail', 'product.hero', 'banner.webp'],
  webhooks: ['stripe.payment_intent.sync', 'stripe.charge.refund', 'shopify.inventory'],
  'abandoned-carts': ['cart.reminder'],
};

/** Each queue fails the way its jobs would: webhooks hit Stripe's rate limit, images hit a bad upload. */
const FAILURE: Record<string, { reason: string; stack: string }> = {
  webhooks: {
    reason: '429 from api.stripe.com — rate limit exceeded',
    stack: 'Error: 429 from api.stripe.com\n    at syncPaymentIntent (dist/jobs/stripe.js:48:11)',
  },
  'image-resize': {
    reason: 'sharp: Input buffer contains unsupported image format',
    stack: 'Error: Input buffer contains unsupported image format\n    at Sharp.toBuffer (node_modules/sharp/lib/output.js:163:17)\n    at resizeProduct (dist/jobs/image-resize.js:31:9)',
  },
  default: {
    reason: 'SMTP 421 from mail.northwind.dev — try again later',
    stack: 'Error: SMTP 421 from mail.northwind.dev\n    at sendMail (dist/jobs/email.js:22:7)',
  },
};

function sample(q: DemoQ) {
  return {
    name: q.name,
    counts: { wait: q.wait, paused: 0, active: q.active, prioritized: 0, delayed: q.delayed, completed: q.completed, failed: q.failed, waitingChildren: 0 },
    isPaused: false,
    jobsTotal: q.wait + q.active + q.delayed + q.completed + q.failed,
    metricsCompleted: q.completed,
    metricsFailed: q.failed,
    events: { completed: q.perMin * 5, failed: q.failed ? 2 : 0, lastId: `${Date.now()}-0`, saturated: false },
    backlog: q.wait,
    rate: {
      completed: q.perMin * 5,
      failed: q.failed ? 2 : 0,
      intervalSeconds: 300,
      throughput: q.perMin,
      failureRate: q.failed ? 0.4 : 0,
      failureRatio: q.failed ? 0.01 : 0,
      saturated: false,
    },
  };
}

function job(queue: string, id: number, state: string, i: number) {
  const names = JOB_NAMES[queue] ?? ['job'];
  const failed = state === 'failed';
  return {
    id: String(id),
    name: names[i % names.length]!,
    data: JSON.stringify(queue === 'webhooks' ? { event: 'payment_intent.succeeded', order_id: 10491 - i, amount: 8400 } : { id: 20_000 + id }),
    opts: JSON.stringify({ attempts: 3, backoff: { type: 'exponential', delay: 30_000 } }),
    atm: failed ? '3' : state === 'completed' ? '1' : '0',
    timestamp: t((i + 1) * 3 * MIN),
    processedOn: state === 'wait' || state === 'delayed' ? null : t((i + 1) * 3 * MIN - 2000),
    finishedOn: failed || state === 'completed' ? t((i + 1) * 3 * MIN - 4000) : null,
    failedReason: failed ? FAILURE[queue]?.reason ?? FAILURE.default!.reason : null,
    stacktrace: failed ? JSON.stringify([FAILURE[queue]?.stack ?? FAILURE.default!.stack]) : null,
    processedBy: state === 'wait' ? null : 'worker.2',
  };
}

export const queueStudio: DomainResolvers = {
  handlers: {
    'queues.studioClusters': (i) => {
      const stack = (i as { stack?: string } | undefined)?.stack;
      return !stack || stack === 'storefront'
        ? [{ stack: 'storefront', cluster: 'main', engine: 'valkey', purpose: 'queue', online: true, host: 'storefront_main' }]
        : [];
    },
    'queues.studioOverview': (i) => {
      const { stack = '', cluster = '', prefix = 'bull' } = (i ?? {}) as { stack?: string; cluster?: string; prefix?: string };
      const queues = stack === 'storefront' && cluster === 'main' ? STOREFRONT_QUEUES.map(sample) : [];
      return { stack, cluster, prefix, purpose: 'queue', primary: `${cluster}-0`, queues, truncated: false, sampledAt: new Date().toISOString() };
    },
    'queues.studioJobs': (i) => {
      const { queue = '', state = 'wait', start = 0 } = (i ?? {}) as { queue?: string; state?: string; start?: number };
      const q = STOREFRONT_QUEUES.find((x) => x.name === queue);
      const total = q ? (({ wait: q.wait, active: q.active, delayed: q.delayed, completed: q.completed, failed: q.failed }) as Record<string, number>)[state] ?? 0 : 0;
      const n = Math.max(0, Math.min(8, total - start));
      const jobs = Array.from({ length: n }, (_, k) => job(queue, 8812 - start - k, state, k));
      return { state, total, start, jobs };
    },
    'queues.studioJob': (i) => {
      const { queue = '', id = '' } = (i ?? {}) as { queue?: string; id?: string };
      if (!STOREFRONT_QUEUES.some((q) => q.name === queue)) return { found: false };
      return {
        found: true,
        state: 'failed',
        job: job(queue, Number(id) || 8812, 'failed', 0),
        logs: ['attempt 1 failed · retry in 30 s', 'attempt 2 failed · retry in 60 s', 'attempt 3 failed · moved to failed'],
        logCount: 3,
      };
    },
    'queues.studioRates': (i) => {
      const { queue = '' } = (i ?? {}) as { queue?: string };
      const q = STOREFRONT_QUEUES.find((x) => x.name === queue);
      const points = Array.from({ length: 24 }, (_, k) => ({
        bucket: new Date(Date.now() - (23 - k) * 15 * MIN).toISOString(),
        completed: Math.round((q?.perMin ?? 0) * 15 * (0.7 + 0.3 * Math.sin(k / 3))),
        failed: q?.failed && k % 7 === 3 ? 3 : 0,
        seconds: 900,
        waiting: Math.round((q?.wait ?? 0) * (0.5 + 0.5 * Math.sin(k / 4))),
      }));
      return { status: 'ok', points };
    },
  },
};
