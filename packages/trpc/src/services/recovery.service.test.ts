import { describe, expect, it, beforeEach } from 'bun:test';
import { createHash } from 'node:crypto';

// Approval encrypts the staged credential with the vault key.
process.env.SWARMY_SECRET_KEY ??= 'test-secret-key-for-recovery-flow';

import {
  claimFingerprint,
  submitRecoveryClaim,
  pollRecoveryClaim,
  resolveRecoveryClaim,
  listRecoveryClaims,
} from './recovery.service';

// Minimal in-memory Prisma stand-in covering the RecoveryClaim + Node surface
// the recovery service touches. Enough to exercise the full state machine
// without a database.
function makeDb() {
  const nodes: Array<{ id: string; orgId: string; hostname: string; sessionSecretHash?: string; sessionVersion: number }> = [
    { id: 'node-1', orgId: 'org-1', hostname: 'box.local', sessionVersion: 5 },
  ];
  let claims: Array<Record<string, unknown>> = [];
  let seq = 0;
  const db = {
    node: {
      findMany: async ({ where, take }: any) =>
        nodes.filter((n) => n.hostname === where.hostname).slice(0, take ?? undefined),
      findFirst: async ({ where }: any) =>
        nodes.find((n) => n.id === where.id && (!where.orgId || n.orgId === where.orgId)) ?? null,
      update: async ({ where, data }: any) => {
        const n = nodes.find((x) => x.id === where.id)!;
        if (data.sessionSecretHash) n.sessionSecretHash = data.sessionSecretHash;
        if (data.sessionVersion?.increment) n.sessionVersion += data.sessionVersion.increment;
        return { sessionVersion: n.sessionVersion };
      },
    },
    recoveryClaim: {
      create: async ({ data, select }: any) => {
        const row = { id: `claim-${seq++}`, status: 'pending', credentialEnc: null, resolvedAt: null, ...data };
        claims.push(row);
        return select ? pick(row, select) : row;
      },
      deleteMany: async ({ where }: any) => {
        const before = claims.length;
        claims = claims.filter(
          (c) => !(c.orgId === where.orgId && c.hostname === where.hostname && c.status === where.status),
        );
        return { count: before - claims.length };
      },
      findUnique: async ({ where }: any) => claims.find((c) => c.id === where.id) ?? null,
      findFirst: async ({ where }: any) =>
        claims.find(
          (c) => c.id === where.id && c.orgId === where.orgId && (!where.status || c.status === where.status),
        ) ?? null,
      findMany: async ({ where, select }: any) => {
        const rows = claims.filter(
          (c) =>
            c.orgId === where.orgId &&
            c.status === where.status &&
            (!where.expiresAt || (c.expiresAt as Date).getTime() > where.expiresAt.gt.getTime()),
        );
        return select ? rows.map((r) => pick(r, select)) : rows;
      },
      update: async ({ where, data }: any) => {
        const c = claims.find((x) => x.id === where.id)!;
        Object.assign(c, data);
        return c;
      },
    },
    _nodes: nodes,
    _claims: () => claims,
  };
  return db;
}

function pick(obj: Record<string, unknown>, select: Record<string, boolean>) {
  return Object.fromEntries(Object.keys(select).map((k) => [k, obj[k]]));
}

const secret = 'claim-secret-abc';
const hash = createHash('sha256').update(secret).digest('hex');

describe('recovery.service', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => {
    db = makeDb();
  });

  it('derives a stable fingerprint from the claim hash', () => {
    expect(claimFingerprint('abcdef1234567890')).toBe('ABCD-EF12');
  });

  it('persists a claim only for a hostname matching exactly one node', async () => {
    const res = await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: hash });
    expect(res.accepted).toBe(true);
    expect(res.claimId).toBeDefined();
    expect(db._claims()).toHaveLength(1);
  });

  it('pretend-accepts an unknown hostname but persists nothing (no enumeration)', async () => {
    const res = await submitRecoveryClaim(db as never, { hostname: 'ghost.local', claimHash: hash });
    expect(res.accepted).toBe(true);
    expect(res.claimId).toBeUndefined();
    expect(db._claims()).toHaveLength(0);
  });

  it('rejects a malformed claim hash', async () => {
    const res = await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: 'not-a-hash' });
    expect(res.accepted).toBe(false);
  });

  it('runs the full approve → one-shot delivery flow and rotates the session', async () => {
    const submit = await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: hash });
    const claimId = submit.claimId!;
    const ctx = { db, activeOrgId: 'org-1' } as never;

    expect(await pollRecoveryClaim(db as never, { claimId, claimSecret: secret })).toEqual({ status: 'pending' });

    const before = db._nodes[0]!.sessionVersion;
    const resolved = await resolveRecoveryClaim(ctx, { id: claimId, approve: true });
    expect(resolved.status).toBe('approved');
    expect(db._nodes[0]!.sessionVersion).toBe(before + 1);
    expect(db._nodes[0]!.sessionSecretHash).toBeDefined();

    const delivered = await pollRecoveryClaim(db as never, { claimId, claimSecret: secret });
    expect(delivered.status).toBe('approved');
    if (delivered.status === 'approved') {
      expect(delivered.nodeId).toBe('node-1');
      expect(delivered.sessionSecret).toStartWith('sst_');
      // The delivered secret's hash must match what was stored on the node.
      expect(createHash('sha256').update(delivered.sessionSecret).digest('hex')).toBe(db._nodes[0]!.sessionSecretHash!);
    }

    // Second poll: credential wiped, nothing returned.
    const replay = await pollRecoveryClaim(db as never, { claimId, claimSecret: secret });
    expect(replay.status).not.toBe('approved');
  });

  it('rejects a poll with the wrong claim secret', async () => {
    const submit = await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: hash });
    const res = await pollRecoveryClaim(db as never, { claimId: submit.claimId!, claimSecret: 'wrong' });
    expect(res.status).toBe('unknown');
  });

  it('denies a claim without minting a credential', async () => {
    const submit = await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: hash });
    const ctx = { db, activeOrgId: 'org-1' } as never;
    const before = db._nodes[0]!.sessionVersion;
    await resolveRecoveryClaim(ctx, { id: submit.claimId!, approve: false });
    expect(db._nodes[0]!.sessionVersion).toBe(before);
    const poll = await pollRecoveryClaim(db as never, { claimId: submit.claimId!, claimSecret: secret });
    expect(poll.status).toBe('denied');
  });

  it('only lists pending claims for the active org', async () => {
    await submitRecoveryClaim(db as never, { hostname: 'box.local', claimHash: hash });
    const ctx = { db, activeOrgId: 'org-1' } as never;
    const list = await listRecoveryClaims(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]!.hostname).toBe('box.local');
    expect(list[0]!.fingerprint).toBe(claimFingerprint(hash));
  });
});
