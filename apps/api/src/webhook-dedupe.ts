/**
 * Durable git webhook dedupe (security review M8).
 *
 * A delivery is recorded in control.db (`GitWebhookDelivery`, history-like
 * rows) under two keys, both scoped to the receiving endpoint:
 *   - the provider's delivery id (X-GitHub-Delivery / X-Gitea-Delivery /
 *     X-Gitlab-Event-UUID) — a provider redelivery is acknowledged, not re-run;
 *   - the sha256 of the raw body. The delivery id is a HEADER the HMAC does
 *     not cover, so a captured signed body replayed under a fresh id is still
 *     caught by its body.
 * Rows survive a controller restart (the old in-memory set did not) and are
 * swept after {@link DELIVERY_TTL_MS}. Past the TTL the plan itself refuses
 * an old commit (apps/stale-commit.ts), so a late replay still can't roll back.
 */
import { createHash } from 'node:crypto';
import type { DB } from '@swarmy/db';

/** Longer than any provider's redelivery window (GitHub keeps deliveries 3 days). */
export const DELIVERY_TTL_MS = 7 * 24 * 3600 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

type DeliveryDb = Pick<DB, 'gitWebhookDelivery'>;

export interface DeliveryInput {
  /** The endpoint that verified it: `app:<GitHubApp id>` or `repo:<GitRepo id>`. */
  scope: string;
  deliveryId: string | null | undefined;
  rawBody: string;
}

/** PURE — the keys one delivery is recorded under. */
export function deliveryKeys(input: DeliveryInput): string[] {
  const body = `${input.scope}|body|${createHash('sha256').update(input.rawBody).digest('hex')}`;
  const id = input.deliveryId?.trim().slice(0, 200);
  return id ? [`${input.scope}|id|${id}`, body] : [body];
}

export class DurableDeliveryDeduper {
  private lastSweep = 0;

  constructor(
    private readonly db: () => DeliveryDb,
    private readonly ttlMs = DELIVERY_TTL_MS,
  ) {}

  /** True the FIRST time a delivery (by id or by body) is seen within the TTL; false for a duplicate. */
  async firstSeen(input: DeliveryInput, now = Date.now()): Promise<boolean> {
    const db = this.db();
    await this.sweep(db, now);
    let first = true;
    for (const key of deliveryKeys(input)) {
      try {
        await db.gitWebhookDelivery.create({ data: { key, receivedAt: new Date(now) } });
      } catch (e) {
        // A primary-key clash is the duplicate; anything else is a real failure (fail closed).
        if (!(await db.gitWebhookDelivery.findUnique({ where: { key } }))) throw e;
        first = false;
      }
    }
    return first;
  }

  /** Drop rows past the TTL, at most every few minutes. */
  private async sweep(db: DeliveryDb, now: number): Promise<void> {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    await db.gitWebhookDelivery.deleteMany({ where: { receivedAt: { lt: new Date(now - this.ttlMs) } } });
  }
}
