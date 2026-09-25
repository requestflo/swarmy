/**
 * Demo issues for the storefront Errors tab (Errors board): a few grouped
 * errors with trends, and one detailed event per issue. Status changes are
 * kept in memory so Resolve / Ignore / Reopen feel live.
 */

type Status = 'unresolved' | 'resolved' | 'resolved_next_release' | 'ignored';

const H = 3_600_000;
const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const trend = (seed: number, spikeAt = 20): number[] => Array.from({ length: 24 }, (_, i) => (i >= spikeAt ? seed * (i - spikeAt + 1) : (i * seed) % 3));

interface Seed {
  fingerprint: string;
  title: string;
  culprit: string;
  type: string;
  level: string;
  count: number;
  users: number;
  firstSeenH: number;
  lastSeenH: number;
  firstRelease: string;
  lastRelease: string;
  regressedH: number | null;
  trend: number[];
}

const SEEDS: Seed[] = [
  { fingerprint: 'f3a91c07e2b4', title: 'TypeError: applePaySession is undefined', culprit: 'checkout/src/pay.ts in startApplePay', type: 'TypeError', level: 'error', count: 318, users: 211, firstSeenH: 2, lastSeenH: 0.1, firstRelease: 'v119', lastRelease: 'v119', regressedH: null, trend: trend(9, 21) },
  { fingerprint: '0b77d2e41a90', title: 'PrismaClientKnownRequestError P2002: unique constraint failed', culprit: 'api/src/orders.ts in createOrder', type: 'PrismaClientKnownRequestError', level: 'error', count: 42, users: 30, firstSeenH: 190, lastSeenH: 2, firstRelease: 'v112', lastRelease: 'v119', regressedH: 2, trend: trend(3, 22) },
  { fingerprint: '5c1e8a3f60d2', title: 'TimeoutError: stripe.paymentIntents.create timed out', culprit: 'checkout/src/stripe.ts in charge', type: 'TimeoutError', level: 'error', count: 19, users: 17, firstSeenH: 30, lastSeenH: 0.7, firstRelease: 'v118', lastRelease: 'v118', regressedH: null, trend: trend(1, 0) },
  { fingerprint: '9d04b6c2f18e', title: 'ChunkLoadError: Loading chunk 812 failed', culprit: 'web/src/router.tsx in lazy', type: 'ChunkLoadError', level: 'warning', count: 64, users: 58, firstSeenH: 20, lastSeenH: 1, firstRelease: 'v118', lastRelease: 'v118', regressedH: null, trend: trend(2, 18) },
];

const statuses = new Map<string, Status>();

function issueView(s: Seed): Record<string, unknown> {
  const status = statuses.get(s.fingerprint) ?? 'unresolved';
  return {
    fingerprint: s.fingerprint, title: s.title, culprit: s.culprit, type: s.type, level: s.level, platform: 'javascript', status,
    resolvedInRelease: status === 'resolved_next_release' ? 'v120' : null, statusChangedAt: null,
    firstSeen: ago(s.firstSeenH * H), firstRelease: s.firstRelease, regressedAt: s.regressedH === null ? null : ago(s.regressedH * H),
    lastSeen: ago(s.lastSeenH * H), lastRelease: s.lastRelease, count: s.count, users: s.users, count24h: s.trend.reduce((a, b) => a + b, 0), trend: s.trend,
  };
}

export function demoIssues(input: { stack: string; status?: string; query?: string }): { status: 'ok'; issues: Record<string, unknown>[] } {
  if (input.stack !== 'storefront') return { status: 'ok', issues: [] };
  const want = input.status ?? 'unresolved';
  const q = input.query?.toLowerCase();
  const issues = SEEDS.map(issueView).filter((v) => (want === 'all' || v.status === want) && (!q || String(v.title).toLowerCase().includes(q) || String(v.culprit).toLowerCase().includes(q)));
  return { status: 'ok', issues };
}

export function demoSetIssueStatus(input: { fingerprint: string; status: Status }): { fingerprint: string; status: Status } {
  statuses.set(input.fingerprint, input.status);
  return { fingerprint: input.fingerprint, status: input.status };
}

export function demoIssue(input: { stack: string; fingerprint: string }): Record<string, unknown> {
  const s = SEEDS.find((x) => x.fingerprint === input.fingerprint);
  if (!s || input.stack !== 'storefront') return { status: 'ok', issue: null, event: null, events: [], tags: [], introducedIn: null };
  const [file, fn] = s.culprit.split(' in ');
  const event = {
    eventId: `${s.fingerprint}aa00ff11`, timestamp: ago(s.lastSeenH * H), release: s.lastRelease, environment: 'production', serverName: 'storefront_checkout.1',
    user: 'u_88213', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', replayId: null,
    title: s.title, level: s.level, platform: 'javascript', message: s.title,
    exceptions: [{ type: s.type, value: s.title.split(': ').slice(1).join(': '), mechanism: 'onunhandledrejection', handled: false, frames: [
      { filename: 'node_modules/react-dom/cjs/react-dom.production.js', function: 'dispatch', lineno: 4120, colno: 9, inApp: false, module: null, preContext: [], contextLine: null, postContext: [], minified: null, sourcemap: null },
      { filename: file ?? 'src/index.ts', function: fn ?? 'handler', lineno: 88, colno: 17, inApp: true, module: null, preContext: ['  const req = buildRequest(cart)'], contextLine: '  const s = new ApplePaySession(3, req)', postContext: ['  s.onvalidatemerchant = validate'], minified: { filename: 'assets/index-4e1c09a.js', function: 'a', lineno: 1, colno: 48211 }, sourcemap: 'assets/index-4e1c09a.js.map' },
    ] }],
    breadcrumbs: [
      { timestamp: ago(s.lastSeenH * H + 35_000), category: 'navigation', level: 'info', message: '/cart → /checkout', type: 'navigation', data: null },
      { timestamp: ago(s.lastSeenH * H + 3_000), category: 'ui.click', level: 'info', message: 'button#apple-pay', type: 'default', data: null },
    ],
    tags: { browser: 'Safari 18', os: 'iOS 18.1', release: s.lastRelease, environment: 'production' }, contexts: {}, request: { method: 'POST', url: '/api/checkout' }, userDetail: { id: 'u_88213' }, sdk: 'sentry.javascript.browser 8.33.0', grouping: null,
  };
  return {
    status: 'ok', issue: issueView(s), event,
    events: [{ eventId: event.eventId, timestamp: event.timestamp, release: s.lastRelease, environment: 'production', serverName: event.serverName, user: 'u_88213', traceId: event.traceId, spanId: event.spanId, replayId: null }],
    tags: [{ key: 'browser', values: [{ value: 'Safari 18', count: s.count }] }, { key: 'release', values: [{ value: s.lastRelease, count: s.count }] }],
    introducedIn: { version: s.firstRelease, commitSha: '4e1c09a2b7d1', environment: 'production', source: 'deploy', swarmyReleaseId: null, firstSeen: ago(s.firstSeenH * H), deployedAt: ago(s.firstSeenH * H + 600_000), newIssues: 1, events: s.count },
  };
}
