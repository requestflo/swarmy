import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDb, type TestDb } from '@swarmy/db';
import type { OrgContext } from '../context';
import { listChannels } from './alerts.service';
import { writeAudit } from './audit.service';
import { TEST_CHANNEL_ACTION } from './alerts-receipts';

/**
 * Saved test receipts (board 55): each channel's newest Send test comes back
 * from the audit log with its time, result, plain words and sender. Real SQL.
 */
let t: TestDb;
const ORG = 'org_rcpt';
const OTHER = 'org_other';

const ctx = (orgId: string, userId: string | null = 'u_cal') =>
  ({ db: t.db, activeOrgId: orgId, user: userId ? { id: userId } : null }) as unknown as OrgContext;

async function tested(orgId: string, channelId: string, ok: boolean, detail: string, at: Date): Promise<void> {
  await writeAudit(ctx(orgId), { action: TEST_CHANNEL_ACTION, targetType: 'notificationChannel', targetId: channelId, metadata: { ok, detail } });
  // Pin the row's time so "newest" is deterministic.
  const row = await t.db.auditLog.findFirst({ where: { orgId, targetId: channelId }, orderBy: { id: 'desc' } });
  await t.db.auditLog.update({ where: { id: row!.id }, data: { ts: at } });
}

beforeAll(async () => {
  t = await createTestDb();
  for (const [id, slug] of [[ORG, 'rcpt'], [OTHER, 'other']] as const) {
    await t.db.organization.create({ data: { id, name: slug, slug, createdAt: new Date() } });
  }
  await t.db.user.create({ data: { id: 'u_cal', name: 'Calum', email: 'calum@a.dev', emailVerified: true, createdAt: new Date(), updatedAt: new Date() } });
  for (const [id, name] of [['ch_slack', 'Ops Slack'], ['ch_hook', 'Pager hook'], ['ch_new', 'New']] as const) {
    await t.db.notificationChannel.create({ data: { id, orgId: ORG, name, kind: 'SLACK' } });
  }
  await tested(ORG, 'ch_slack', false, 'HTTP 404', new Date('2026-10-24T09:00:00Z'));
  await tested(ORG, 'ch_slack', true, 'delivered (HTTP 200)', new Date('2026-10-24T10:42:00Z'));
  await tested(ORG, 'ch_hook', false, 'HTTP 404', new Date('2026-10-24T08:00:00Z'));
  // Another org testing a channel with the same id never leaks in.
  await tested(OTHER, 'ch_new', true, 'delivered (HTTP 200)', new Date('2026-10-24T11:00:00Z'));
});
afterAll(async () => {
  await t?.close();
});

describe('alerts.channels: saved test receipts', () => {
  it('carries each channel’s newest test, in plain words, with who sent it', async () => {
    const byId = Object.fromEntries((await listChannels(ctx(ORG))).map((c) => [c.id, c.lastTest]));
    expect(byId.ch_slack).toEqual({ at: '2026-10-24T10:42:00.000Z', ok: true, detail: 'delivered (HTTP 200)', words: 'Delivered: the service accepted it.', by: 'Calum' });
    expect(byId.ch_hook).toMatchObject({ ok: false, detail: 'HTTP 404', words: expect.stringContaining('no longer exists') });
  });

  it('is null for a channel never tested in this org', async () => {
    const ch = (await listChannels(ctx(ORG))).find((c) => c.id === 'ch_new');
    expect(ch?.lastTest).toBeNull();
  });
});
