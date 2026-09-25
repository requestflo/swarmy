import { describe, expect, it } from 'bun:test';
import type { OrgContext } from '../context';
import { decideNodeShellApproval, type TerminalApprovalRow } from './terminal.service';

function ctxWith(rows: TerminalApprovalRow[], userId = 'u-admin'): OrgContext {
  const db = {
    terminalApproval: {
      findFirst: async ({ where }: { where: { id: string; orgId: string } }) =>
        rows.find((r) => r.id === where.id && r.orgId === where.orgId) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<TerminalApprovalRow> }) => {
        const r = rows.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return r;
      },
    },
    auditLog: { create: async () => ({}) },
  };
  return { db, activeOrgId: 'org-a', user: { id: userId } } as unknown as OrgContext;
}

function row(over: Partial<TerminalApprovalRow> = {}): TerminalApprovalRow {
  return {
    id: 'ap1',
    orgId: 'org-a',
    requestedById: 'u-member',
    nodeId: 'n1',
    reason: 'triage',
    status: 'pending',
    approvedById: null,
    expiresAt: new Date(Date.now() + 60_000),
    createdAt: new Date(),
    ...over,
  };
}

describe('decideNodeShellApproval', () => {
  it('another admin approves a pending request', async () => {
    const r = await decideNodeShellApproval(ctxWith([row()]), { approvalId: 'ap1', approve: true });
    expect(r).toMatchObject({ status: 'approved', approvedById: 'u-admin' });
  });

  it("refuses another org's request", async () => {
    const ctx = ctxWith([row({ orgId: 'org-b' })]);
    await expect(decideNodeShellApproval(ctx, { approvalId: 'ap1', approve: true })).rejects.toThrow('not found');
  });

  it('refuses deciding your own request', async () => {
    const ctx = ctxWith([row({ requestedById: 'u-admin' })]);
    await expect(decideNodeShellApproval(ctx, { approvalId: 'ap1', approve: true })).rejects.toThrow('another admin');
  });

  it('refuses a request that is already decided or expired', async () => {
    await expect(
      decideNodeShellApproval(ctxWith([row({ status: 'denied' })]), { approvalId: 'ap1', approve: true }),
    ).rejects.toThrow('already denied');
    await expect(
      decideNodeShellApproval(ctxWith([row({ expiresAt: new Date(Date.now() - 1) })]), { approvalId: 'ap1', approve: true }),
    ).rejects.toThrow('expired');
  });
});
