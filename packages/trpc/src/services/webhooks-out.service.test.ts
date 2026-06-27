import { describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import type { DB } from '@swarmy/db';
import {
  backoffMs,
  enqueueEvent,
  MAX_ATTEMPTS,
  signPayload,
  verifySignature,
} from './webhooks-out.service';

const SECRET = 'whsec_unit_test_secret';
const BODY = JSON.stringify({ event: 'service.deployed', id: 'svc_1' });

describe('signPayload — HMAC-SHA256', () => {
  it('produces a sha256=<hex> header matching a reference HMAC', () => {
    const expected = `sha256=${createHmac('sha256', SECRET).update(BODY).digest('hex')}`;
    expect(signPayload(SECRET, BODY)).toBe(expected);
  });

  it('is deterministic for the same secret + body', () => {
    expect(signPayload(SECRET, BODY)).toBe(signPayload(SECRET, BODY));
  });

  it('changes when the body changes', () => {
    expect(signPayload(SECRET, BODY)).not.toBe(signPayload(SECRET, BODY + ' '));
  });

  it('changes when the secret changes', () => {
    expect(signPayload(SECRET, BODY)).not.toBe(signPayload('other-secret', BODY));
  });

  it('verifies its own signature and rejects a tampered body', () => {
    const sig = signPayload(SECRET, BODY);
    expect(verifySignature(SECRET, BODY, sig)).toBe(true);
    expect(verifySignature(SECRET, BODY + 'x', sig)).toBe(false);
    expect(verifySignature('wrong', BODY, sig)).toBe(false);
  });
});

describe('backoffMs — exponential schedule with a cap', () => {
  it('follows 30s, 1m, 2m, 4m, 8m … doubling per attempt', () => {
    expect(backoffMs(1)).toBe(30_000);
    expect(backoffMs(2)).toBe(60_000);
    expect(backoffMs(3)).toBe(120_000);
    expect(backoffMs(4)).toBe(240_000);
    expect(backoffMs(5)).toBe(480_000);
  });

  it('caps at one hour for large attempt counts', () => {
    expect(backoffMs(20)).toBe(3_600_000);
    expect(backoffMs(MAX_ATTEMPTS)).toBeLessThanOrEqual(3_600_000);
  });

  it('treats attempt 0 like attempt 1 (never negative exponent)', () => {
    expect(backoffMs(0)).toBe(30_000);
  });

  it('is monotonically non-decreasing', () => {
    let prev = 0;
    for (let a = 1; a <= 12; a++) {
      const cur = backoffMs(a);
      expect(cur).toBeGreaterThanOrEqual(prev);
      prev = cur;
    }
  });
});

// ── enqueueEvent fan-out filtering ─────────────────────────────────────────────

interface FakeEndpoint {
  id: string;
  orgId: string;
  url: string;
  secret: string;
  events: string[];
  active: boolean;
  createdAt: Date;
}

function fakeDb(endpoints: FakeEndpoint[]) {
  const created: Array<Record<string, unknown>> = [];
  const db = {
    webhookEndpoint: {
      async findMany({ where }: { where: { orgId: string; active?: boolean } }) {
        return endpoints.filter(
          (e) =>
            e.orgId === where.orgId && (where.active === undefined || e.active === where.active),
        );
      },
    },
    webhookDelivery: {
      async create({ data }: { data: Record<string, unknown> }) {
        const row = { id: `del_${created.length + 1}`, ...data };
        created.push(row);
        return row;
      },
    },
  };
  return { db: db as unknown as DB, created };
}

const ENDPOINTS: FakeEndpoint[] = [
  { id: 'e1', orgId: 'org1', url: 'https://a', secret: 'x', events: ['service.deployed'], active: true, createdAt: new Date() },
  { id: 'e2', orgId: 'org1', url: 'https://b', secret: 'x', events: ['service.removed'], active: true, createdAt: new Date() },
  { id: 'e3', orgId: 'org1', url: 'https://c', secret: 'x', events: ['*'], active: true, createdAt: new Date() },
  { id: 'e4', orgId: 'org1', url: 'https://d', secret: 'x', events: ['service.deployed'], active: false, createdAt: new Date() },
  { id: 'e5', orgId: 'org2', url: 'https://e', secret: 'x', events: ['service.deployed'], active: true, createdAt: new Date() },
];

describe('enqueueEvent — fan-out filtering by event type', () => {
  it('creates a delivery only for active endpoints subscribed to the event (incl wildcard)', async () => {
    const { db, created } = fakeDb(ENDPOINTS);
    const ids = await enqueueEvent(db, 'org1', 'service.deployed', { id: 'svc_1' });

    // e1 (exact) + e3 (wildcard). NOT e2 (other event), e4 (inactive), e5 (other org).
    expect(ids.length).toBe(2);
    const endpointIds = created.map((c) => c.endpointId).sort();
    expect(endpointIds).toEqual(['e1', 'e3']);
  });

  it('stamps each delivery as pending, attempts=0, due now, with the payload + eventType', async () => {
    const { db, created } = fakeDb(ENDPOINTS);
    await enqueueEvent(db, 'org1', 'service.deployed', { id: 'svc_42' });
    for (const row of created) {
      expect(row.status).toBe('pending');
      expect(row.attempts).toBe(0);
      expect(row.eventType).toBe('service.deployed');
      expect(row.payload).toEqual({ id: 'svc_42' });
      expect(row.nextAttemptAt).toBeInstanceOf(Date);
    }
  });

  it('returns [] and creates nothing when no endpoint matches', async () => {
    // Drop the wildcard endpoint (e3) so an unsubscribed event matches nothing.
    const noWildcard = ENDPOINTS.filter((e) => !e.events.includes('*'));
    const { db, created } = fakeDb(noWildcard);
    const ids = await enqueueEvent(db, 'org1', 'unsubscribed.event', {});
    expect(ids).toEqual([]);
    expect(created.length).toBe(0);
  });

  it('a wildcard (*) endpoint matches any event type', async () => {
    const { db, created } = fakeDb(ENDPOINTS);
    const ids = await enqueueEvent(db, 'org1', 'some.novel.event', {});
    // Only e3 (wildcard) in org1 matches.
    expect(ids.length).toBe(1);
    expect(created[0]!.endpointId).toBe('e3');
  });

  it('isolates by org (org2 endpoint is never fanned for org1 events)', async () => {
    const { db, created } = fakeDb(ENDPOINTS);
    await enqueueEvent(db, 'org1', 'service.deployed', {});
    expect(created.every((c) => c.orgId === 'org1')).toBe(true);
  });
});
