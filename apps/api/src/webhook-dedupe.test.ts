import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import { DELIVERY_TTL_MS, deliveryKeys, DurableDeliveryDeduper } from './webhook-dedupe';

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb();
});
afterAll(() => t.close());

const PUSH = JSON.stringify({ ref: 'refs/heads/main', before: 'a'.repeat(40), after: 'b'.repeat(40) });

describe('M8: webhook deliveries are deduped durably (control.db)', () => {
  it('keys a delivery by its id and by the hash of the signed body, per endpoint', () => {
    const keys = deliveryKeys({ scope: 'repo:r1', deliveryId: 'd-1', rawBody: PUSH });
    expect(keys[0]).toBe('repo:r1|id|d-1');
    expect(keys[1]).toMatch(/^repo:r1\|body\|[0-9a-f]{64}$/);
    expect(deliveryKeys({ scope: 'repo:r1', deliveryId: null, rawBody: PUSH })).toEqual([keys[1]!]);
  });

  it('a redelivery, or the same signed body under a fresh delivery id, is a duplicate', async () => {
    const d = new DurableDeliveryDeduper(() => t.db);
    expect(await d.firstSeen({ scope: 'app:a1', deliveryId: 'd-1', rawBody: PUSH })).toBe(true);
    expect(await d.firstSeen({ scope: 'app:a1', deliveryId: 'd-1', rawBody: PUSH })).toBe(false);
    // The delivery id is an unsigned header: a replay can pick a new one; its body gives it away.
    expect(await d.firstSeen({ scope: 'app:a1', deliveryId: 'forged-new-id', rawBody: PUSH })).toBe(false);
    expect(await d.firstSeen({ scope: 'app:a1', deliveryId: null, rawBody: PUSH })).toBe(false);
    // Another endpoint, or another push, is new.
    expect(await d.firstSeen({ scope: 'repo:r9', deliveryId: 'd-1', rawBody: PUSH })).toBe(true);
    expect(await d.firstSeen({ scope: 'app:a1', deliveryId: 'd-2', rawBody: `${PUSH} ` })).toBe(true);
  });

  it('survives a controller restart (a new deduper over the same store)', async () => {
    const before = new DurableDeliveryDeduper(() => t.db);
    expect(await before.firstSeen({ scope: 'repo:r2', deliveryId: 'x', rawBody: 'body-x' })).toBe(true);
    const after = new DurableDeliveryDeduper(() => t.db);
    expect(await after.firstSeen({ scope: 'repo:r2', deliveryId: 'x', rawBody: 'body-x' })).toBe(false);
  });

  it('sweeps rows past the TTL', async () => {
    const now = Date.now();
    const old = new DurableDeliveryDeduper(() => t.db);
    expect(await old.firstSeen({ scope: 'repo:r3', deliveryId: 'y', rawBody: 'body-y' }, now - DELIVERY_TTL_MS - 60_000)).toBe(true);
    const fresh = new DurableDeliveryDeduper(() => t.db);
    expect(await fresh.firstSeen({ scope: 'repo:r3', deliveryId: 'y', rawBody: 'body-y' }, now)).toBe(true);
    const left = await t.db.gitWebhookDelivery.findMany({ where: { key: { startsWith: 'repo:r3|' } } });
    expect(left.every((r) => r.receivedAt.getTime() === now)).toBe(true);
  });
});
