/**
 * Inbound webhook dispatch worker (slice B4 webhook-gateway).
 *
 * Every tick, drain due `InboundDelivery` rows (status=PENDING, nextAttemptAt
 * <= now) and deliver each to its endpoint's target:
 *
 *   - queue target  → push into a queue on the org's managed cache cluster via
 *     one `redis-cli`/`valkey-cli` exec on the cluster PRIMARY container (the
 *     password never rides the wire — the container reads its mounted secret
 *     file). Convention `list` is the safe default: `RPUSH <queue> <raw body>`.
 *     Convention `bullmq` is a best-effort minimal BullMQ-compatible insert —
 *     see `bullmqPushScript` below.
 *   - forward target → controller `fetch` POST of the raw body to a
 *     controller-reachable http(s) URL (the controller cannot reach overlay
 *     networks — in-cluster consumers should use a queue target).
 *
 * Outcomes: 2xx/exit-0 → DELIVERED; failure → retry with backoff
 * (1m, 5m, 15m, 1h, 6h) until 6 total attempts, then DEAD. Replay (tRPC) just
 * resets a row to PENDING + due-now, so it flows through here again.
 *
 * The backoff schedule / target codec / redis command builders mirror the
 * unit-tested canonical copies in `@swarmy/trpc` `inboundWebhooks.service.ts`
 * and `queues.service.ts` (a worker cannot subpath-import an internal trpc
 * module — same constraint queue-reconcile documents). Keep in sync.
 *
 * Also prunes delivery history hourly per each endpoint's `retentionDays`.
 */
import { prisma } from '@swarmy/db';
import type { SwarmServiceInfo, ContainerInfo } from '@swarmy/core/protocol';
import { hub } from '../gateway';
import { normalizeHeadersJson, renderInboundTemplate } from '../inbound-template';

const TICK_MS = 10_000;
/** Max deliveries handled per tick (fairness / backpressure). */
const BATCH = 25;
/** Per-request timeout for forward targets. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Exec timeout for queue pushes. */
const EXEC_TIMEOUT_MS = 20_000;
/** Retention pruning cadence. */
const PRUNE_EVERY_MS = 3_600_000;

// ── Mirrors of the unit-tested canonical copies (inboundWebhooks.service.ts) ──

/** 1 initial attempt + 5 retries at these delays, then DEAD. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 21_600_000] as const;
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;

function backoffMs(attempts: number): number {
  const i = Math.max(0, Math.min(attempts - 1, BACKOFF_MS.length - 1));
  return BACKOFF_MS[i]!;
}

interface QueueTarget {
  kind: 'queue';
  cacheCluster: string;
  queue: string;
  convention: 'bullmq' | 'list';
}
interface ForwardTarget {
  kind: 'forward';
  url: string;
}
type Target = QueueTarget | ForwardTarget;

function parseTarget(json: unknown): Target | null {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  if (o.kind === 'queue') {
    if (typeof o.cacheCluster !== 'string' || !o.cacheCluster) return null;
    if (typeof o.queue !== 'string' || !o.queue) return null;
    return {
      kind: 'queue',
      cacheCluster: o.cacheCluster,
      queue: o.queue,
      convention: o.convention === 'bullmq' ? 'bullmq' : 'list',
    };
  }
  if (o.kind === 'forward') {
    if (typeof o.url !== 'string' || !/^https?:\/\//.test(o.url)) return null;
    return { kind: 'forward', url: o.url };
  }
  return null;
}

// ── Cache-cluster plumbing (mirror of queue-reconcile.ts, A3 labels) ──────────

const CACHE_CLUSTER_LABEL = 'swarmy.cache.cluster';
const CACHE_ROLE_LABEL = 'swarmy.cache.role';
const CACHE_ENGINE_LABEL = 'swarmy.cache.engine';
const STACK_LABEL = 'com.docker.stack.namespace';
const SWARM_SERVICE_ID_LABEL = 'com.docker.swarm.service.id';
const SECRET_TARGET = 'cache-password';

/** `<stack>/<cluster>` matches exactly; a bare `<cluster>` searches all stacks. */
function findCachePrimary(
  services: SwarmServiceInfo[],
  cacheCluster: string,
): SwarmServiceInfo | undefined {
  const i = cacheCluster.indexOf('/');
  const stack = i > 0 ? cacheCluster.slice(0, i) : null;
  const cluster = i > 0 ? cacheCluster.slice(i + 1) : cacheCluster;
  return services.find(
    (s) =>
      s.labels[CACHE_ROLE_LABEL] === 'primary' &&
      s.labels[CACHE_CLUSTER_LABEL] === cluster &&
      (stack === null || (s.labels[STACK_LABEL] ?? '') === stack),
  );
}

/** A running container of the service + the node hosting it (org-scoped). */
function execTarget(
  orgId: string,
  service: SwarmServiceInfo,
): { nodeId: string; containerId: string } | undefined {
  const orgContainerIds = new Set(hub.liveInventory(orgId).containers.map((cc) => cc.id));
  for (const nodeId of hub.onlineNodeIds()) {
    const match = hub.latestContainers(nodeId).find((cc: ContainerInfo) => {
      if (!orgContainerIds.has(cc.id)) return false;
      const sid = cc.serviceId ?? cc.labels?.[SWARM_SERVICE_ID_LABEL];
      return sid === service.id && cc.state === 'running';
    });
    if (match) return { nodeId, containerId: match.id };
  }
  return undefined;
}

// ── Redis command builders ────────────────────────────────────────────────────

function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** Queue/list names ride inside shell double-quotes — restrict to safe chars. */
const SAFE_KEY_RE = /^[A-Za-z0-9._:-]+$/;

function cliPrefix(engine: 'valkey' | 'redis'): string {
  const cli = engine === 'redis' ? 'redis-cli' : 'valkey-cli';
  return `${cli} --no-auth-warning -a "$(cat /run/secrets/${SECRET_TARGET})"`;
}

/** Safe default: append the raw body to a plain list. */
function listPushScript(engine: 'valkey' | 'redis', queue: string, body: string): string {
  return `${cliPrefix(engine)} RPUSH ${shQuote(queue)} ${shQuote(body)}`;
}

/**
 * Best-effort minimal BullMQ-compatible job insert (BullMQ v5 conventions):
 *   1. `INCR bull:<q>:id`                      → auto-increment job id
 *   2. `HSET bull:<q>:<id> name … data … opts …` → the job hash
 *   3. `LPUSH bull:<q>:wait <id>`              → enqueue FIFO (workers pop from
 *      the right via BRPOPLPUSH wait→active)
 *
 * Known gaps vs a real `queue.add()`: no `bull:<q>:marker` wake-up (an idle v5
 * worker only notices on its next blocking-poll timeout), no events stream
 * entry, no dedup/priority handling. Fine for webhook fan-in; use convention
 * `list` when the consumer is not BullMQ.
 */
function bullmqPushScript(
  engine: 'valkey' | 'redis',
  queue: string,
  dataJson: string,
  timestampMs: number,
): string {
  const cli = cliPrefix(engine);
  const idKey = `bull:${queue}:id`;
  const waitKey = `bull:${queue}:wait`;
  return (
    `ID=$(${cli} INCR ${shQuote(idKey)}) && ` +
    `${cli} HSET "bull:${queue}:$ID" ` +
    `name ${shQuote('webhook')} data ${shQuote(dataJson)} opts ${shQuote('{}')} ` +
    `timestamp ${timestampMs} delay 0 priority 0 attemptsMade 0 && ` +
    `${cli} LPUSH ${shQuote(waitKey)} "$ID"`
  );
}

// ── Row plumbing ──────────────────────────────────────────────────────────────

interface EndpointRow {
  id: string;
  slug: string;
  targetJson: unknown;
  retentionDays: number;
  /** Handlebars-style body transform applied before delivery; null = pass-through. */
  transformTemplate: string | null;
}

interface DeliveryRow {
  id: string;
  orgId: string;
  endpointId: string;
  receivedAt: Date;
  headersJson: unknown;
  bodyText: string;
  attempts: number;
  endpoint: EndpointRow;
}

async function markDelivered(id: string, attempts: number): Promise<void> {
  await prisma.inboundDelivery.update({
    where: { id },
    data: { status: 'DELIVERED', attempts, lastError: null, nextAttemptAt: null },
  });
}

async function markFailed(id: string, attempts: number, error: string): Promise<void> {
  const dead = attempts >= MAX_ATTEMPTS;
  await prisma.inboundDelivery.update({
    where: { id },
    data: {
      status: dead ? 'DEAD' : 'PENDING',
      attempts,
      lastError: error.slice(0, 2_000),
      nextAttemptAt: dead ? null : new Date(Date.now() + backoffMs(attempts)),
    },
  });
}

function headerOf(json: unknown, key: string): string | undefined {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined;
  const v = (json as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

// ── Delivery paths ────────────────────────────────────────────────────────────

async function deliverToQueue(row: DeliveryRow, target: QueueTarget): Promise<string | null> {
  if (!SAFE_KEY_RE.test(target.queue)) return `unsafe queue name "${target.queue}"`;

  const { services } = hub.liveInventory(row.orgId);
  const primary = findCachePrimary(services, target.cacheCluster);
  if (!primary) return `cache cluster "${target.cacheCluster}" not found`;
  const exec = execTarget(row.orgId, primary);
  if (!exec) return `cache primary "${primary.name}" has no running container`;

  const engine = primary.labels[CACHE_ENGINE_LABEL] === 'redis' ? 'redis' : 'valkey';
  const script =
    target.convention === 'bullmq'
      ? bullmqPushScript(
          engine,
          target.queue,
          JSON.stringify({
            deliveryId: row.id,
            endpoint: row.endpoint.slug,
            receivedAt: row.receivedAt.toISOString(),
            headers: row.headersJson ?? {},
            body: row.bodyText,
          }),
          Date.now(),
        )
      : listPushScript(engine, target.queue, row.bodyText);

  try {
    const res = await hub.dispatch<{ exitCode: number; output?: string }>(
      exec.nodeId,
      'exec',
      {
        target: { containerId: exec.containerId },
        cmd: ['sh', '-c', script],
        tty: false,
        stream: false,
      },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
    if (res.exitCode !== 0) {
      return `redis push exited ${res.exitCode}: ${(res.output ?? '').slice(0, 200)}`;
    }
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function deliverToForward(row: DeliveryRow, target: ForwardTarget): Promise<string | null> {
  try {
    const res = await fetch(target.url, {
      method: 'POST',
      headers: {
        'content-type': headerOf(row.headersJson, 'content-type') ?? 'application/json',
        'user-agent': 'swarmy-inbound-gateway/1',
        'x-swarmy-delivery': row.id,
        'x-swarmy-endpoint': row.endpoint.slug,
      },
      body: row.bodyText,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) return `HTTP ${res.status}`;
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

async function deliverOne(row: DeliveryRow): Promise<void> {
  const attempts = row.attempts + 1;
  const target = parseTarget(row.endpoint.targetJson);
  if (!target) {
    // Malformed target is not retryable — dead-letter immediately.
    await prisma.inboundDelivery.update({
      where: { id: row.id },
      data: { status: 'DEAD', attempts, lastError: 'malformed endpoint target', nextAttemptAt: null },
    });
    return;
  }
  // Body transform: the endpoint's template reshapes what the target receives
  // ({{body}}, {{headers.x}}, {{json.path}}, {{slug}}, {{deliveryId}}). The
  // stored delivery keeps the ORIGINAL body — replays re-run the transform.
  const effective: DeliveryRow = row.endpoint.transformTemplate
    ? {
        ...row,
        bodyText: renderInboundTemplate(row.endpoint.transformTemplate, {
          body: row.bodyText,
          headers: normalizeHeadersJson(row.headersJson),
          slug: row.endpoint.slug,
          deliveryId: row.id,
        }),
      }
    : row;
  const error =
    target.kind === 'queue'
      ? await deliverToQueue(effective, target)
      : await deliverToForward(effective, target);
  if (error === null) await markDelivered(row.id, attempts);
  else await markFailed(row.id, attempts, error);
}

// ── Tick + retention pruning ──────────────────────────────────────────────────

async function runDue(): Promise<void> {
  const now = new Date();
  const due = (await prisma.inboundDelivery.findMany({
    where: { status: 'PENDING', nextAttemptAt: { lte: now } },
    include: {
      endpoint: {
        select: { id: true, slug: true, targetJson: true, retentionDays: true, transformTemplate: true },
      },
    },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
  })) as unknown as DeliveryRow[];
  for (const row of due) {
    await deliverOne(row).catch(() => undefined);
  }
}

/** Delete deliveries older than each endpoint's retentionDays (all orgs). */
async function pruneOld(): Promise<void> {
  const endpoints = await prisma.inboundEndpoint.findMany({
    select: { id: true, retentionDays: true },
  });
  for (const ep of endpoints) {
    const cutoff = new Date(Date.now() - ep.retentionDays * 24 * 3_600_000);
    await prisma.inboundDelivery
      .deleteMany({ where: { endpointId: ep.id, receivedAt: { lt: cutoff } } })
      .catch(() => undefined);
  }
}

export function startInboundWebhookDispatch(): () => void {
  let lastPrune = 0;
  const timer = setInterval(() => {
    runDue().catch(() => undefined);
    if (Date.now() - lastPrune >= PRUNE_EVERY_MS) {
      lastPrune = Date.now();
      pruneOld().catch(() => undefined);
    }
  }, TICK_MS);
  return () => clearInterval(timer);
}
