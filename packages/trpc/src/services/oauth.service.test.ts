import { describe, expect, it } from 'bun:test';
import { hashToken } from '@swarmy/core/crypto';
import type { DB } from '@swarmy/db';
import { verifyClientCredentials } from './oauth.service';

interface FakeClient {
  id: string;
  orgId: string;
  name: string;
  clientId: string;
  clientSecretHash: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

const GOOD_SECRET = 'swcs_correct_horse_battery_staple';

function client(overrides: Partial<FakeClient> = {}): FakeClient {
  return {
    id: 'c1',
    orgId: 'org1',
    name: 'terraform',
    clientId: 'swc_abc123',
    clientSecretHash: hashToken(GOOD_SECRET),
    scopes: ['read', 'write'],
    createdAt: new Date(),
    lastUsedAt: null,
    revokedAt: null,
    ...overrides,
  };
}

function fakeDb(rows: FakeClient[]) {
  const db = {
    oAuthClient: {
      async findUnique({ where }: { where: { clientId: string } }) {
        return rows.find((r) => r.clientId === where.clientId) ?? null;
      },
    },
  };
  return db as unknown as DB;
}

describe('verifyClientCredentials — client-secret verification', () => {
  it('accepts the correct clientId + secret', async () => {
    const db = fakeDb([client()]);
    const row = await verifyClientCredentials(db, 'swc_abc123', GOOD_SECRET);
    expect(row?.id).toBe('c1');
  });

  it('rejects a wrong secret (hash mismatch)', async () => {
    const db = fakeDb([client()]);
    expect(await verifyClientCredentials(db, 'swc_abc123', 'swcs_wrong')).toBeNull();
  });

  it('rejects an unknown clientId', async () => {
    const db = fakeDb([client()]);
    expect(await verifyClientCredentials(db, 'swc_nope', GOOD_SECRET)).toBeNull();
  });

  it('rejects a revoked client even with the correct secret', async () => {
    const db = fakeDb([client({ revokedAt: new Date() })]);
    expect(await verifyClientCredentials(db, 'swc_abc123', GOOD_SECRET)).toBeNull();
  });

  it('rejects empty credentials without a db hit', async () => {
    const db = fakeDb([client()]);
    expect(await verifyClientCredentials(db, '', GOOD_SECRET)).toBeNull();
    expect(await verifyClientCredentials(db, 'swc_abc123', '')).toBeNull();
  });
});
