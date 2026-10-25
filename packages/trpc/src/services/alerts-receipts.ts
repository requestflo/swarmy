/**
 * Saved test receipts (board 55): each channel's last Send test, read back
 * from the audit log. Every test already writes an `alerts.testChannel` row
 * (`{ ok, detail }`, its time and who sent it), and the audit log is swarmy's
 * queryable history, so the receipt needs no column of its own and keeps the
 * whole history for free. Org-scoped; the detail is the redacted one the
 * transport returned (`redactSecrets`), never a secret.
 */
import { channelResultWords, type ChannelTestReceiptView } from '@swarmy/core';
import type { OrgContext } from '../context';

export const TEST_CHANNEL_ACTION = 'alerts.testChannel';

/** The newest test of each channel (absent = never tested, or past audit retention). */
export async function lastChannelTests(ctx: OrgContext, channelIds: readonly string[]): Promise<Map<string, ChannelTestReceiptView>> {
  const out = new Map<string, ChannelTestReceiptView>();
  const rows = await Promise.all(
    channelIds.map((id) =>
      ctx.db.auditLog.findFirst({
        where: { orgId: ctx.activeOrgId, action: TEST_CHANNEL_ACTION, targetType: 'notificationChannel', targetId: id },
        orderBy: { ts: 'desc' },
        select: { targetId: true, ts: true, metadata: true, actor: { select: { name: true } } },
      }),
    ),
  );
  for (const row of rows) {
    if (!row?.targetId) continue;
    const m = (row.metadata ?? {}) as { ok?: unknown; detail?: unknown };
    const ok = m.ok === true;
    const detail = typeof m.detail === 'string' ? m.detail : ok ? 'delivered' : 'no detail recorded';
    out.set(row.targetId, { at: row.ts.toISOString(), ok, detail, words: channelResultWords(ok, detail), by: row.actor?.name ?? null });
  }
  return out;
}
