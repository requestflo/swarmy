/**
 * Outbound webhook dispatch worker (epic #13 public-api-terraform, Phase 2).
 *
 * Every few seconds: drain due `WebhookDelivery` rows (status=pending,
 * nextAttemptAt <= now), POST each payload to its endpoint with an HMAC-SHA256
 * signature header, and record the outcome:
 *   - 2xx           → status=delivered, deliveredAt stamped.
 *   - non-2xx/error → increment attempts; if attempts < MAX_ATTEMPTS reschedule
 *                     with exponential backoff, else status=failed.
 *
 * Signing + the backoff schedule are pure functions in
 * `@swarmy/trpc` (`signPayload`, `backoffMs`) so they are unit-tested in
 * isolation. Mirrors `backup-scheduler`: prisma + a narrow delegate cast for the
 * not-yet-generated models. Registered in workers/index.ts (snippet in INTEGRATION).
 */
import { prisma } from '@swarmy/db';
import { decryptSecret } from '@swarmy/core/crypto';
import {
  backoffMs,
  signPayload,
  DELIVERY_HEADER,
  EVENT_HEADER,
  MAX_ATTEMPTS,
  SIGNATURE_HEADER,
} from '@swarmy/trpc';

const TICK_MS = 5_000;
/** Per-request timeout so a hanging endpoint can't stall the worker. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Max deliveries handled per tick (fairness / backpressure). */
const BATCH = 50;

interface DeliveryRow {
  id: string;
  orgId: string;
  endpointId: string;
  eventType: string;
  payload: unknown;
  attempts: number;
}

interface EndpointRow {
  id: string;
  url: string;
  secret: string; // encrypted blob
  active: boolean;
}

// The `webhookDelivery`/`webhookEndpoint` models are added to the Prisma schema
// as part of this epic; reach them through a single narrow cast until generated.
function models(): {
  webhookDelivery: {
    findMany(a: unknown): Promise<DeliveryRow[]>;
    update(a: unknown): Promise<unknown>;
  };
  webhookEndpoint: {
    findUnique(a: unknown): Promise<EndpointRow | null>;
  };
} {
  return prisma as unknown as {
    webhookDelivery: {
      findMany(a: unknown): Promise<DeliveryRow[]>;
      update(a: unknown): Promise<unknown>;
    };
    webhookEndpoint: { findUnique(a: unknown): Promise<EndpointRow | null> };
  };
}

async function deliverOne(row: DeliveryRow): Promise<void> {
  const db = models();
  const endpoint = await db.webhookEndpoint.findUnique({ where: { id: row.endpointId } });

  // Endpoint gone or disabled since enqueue → terminal failure, no retry.
  if (!endpoint || !endpoint.active) {
    await db.webhookDelivery.update({
      where: { id: row.id },
      data: {
        status: 'failed',
        lastError: 'endpoint missing or inactive',
        nextAttemptAt: null,
      },
    });
    return;
  }

  const rawBody = JSON.stringify(row.payload ?? {});
  const secret = decryptSecret(endpoint.secret);
  const attempts = row.attempts + 1;

  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'swarmy-webhooks/1',
        [SIGNATURE_HEADER]: signPayload(secret, rawBody),
        [EVENT_HEADER]: row.eventType,
        [DELIVERY_HEADER]: row.id,
      },
      body: rawBody,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (res.ok) {
      await db.webhookDelivery.update({
        where: { id: row.id },
        data: {
          status: 'delivered',
          attempts,
          deliveredAt: new Date(),
          lastError: null,
          nextAttemptAt: null,
        },
      });
      return;
    }
    await scheduleRetryOrFail(row.id, attempts, `HTTP ${res.status}`);
  } catch (e) {
    await scheduleRetryOrFail(row.id, attempts, e instanceof Error ? e.message : String(e));
  }
}

async function scheduleRetryOrFail(id: string, attempts: number, error: string): Promise<void> {
  const db = models();
  if (attempts >= MAX_ATTEMPTS) {
    await db.webhookDelivery.update({
      where: { id },
      data: { status: 'failed', attempts, lastError: error, nextAttemptAt: null },
    });
    return;
  }
  await db.webhookDelivery.update({
    where: { id },
    data: {
      status: 'pending',
      attempts,
      lastError: error,
      nextAttemptAt: new Date(Date.now() + backoffMs(attempts)),
    },
  });
}

async function runDue(): Promise<void> {
  const now = new Date();
  const due = await models().webhookDelivery.findMany({
    where: { status: 'pending', nextAttemptAt: { lte: now } },
    orderBy: { nextAttemptAt: 'asc' },
    take: BATCH,
  });
  for (const row of due) {
    await deliverOne(row).catch(() => undefined);
  }
}

export function startWebhookDispatch(): () => void {
  const timer = setInterval(() => {
    runDue().catch(() => undefined);
  }, TICK_MS);
  return () => clearInterval(timer);
}
