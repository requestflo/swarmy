import type { DB } from '@swarmy/db';
import type { TermTarget } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { writeAudit } from './audit.service';

/**
 * Terminal session persistence + policy (epic #11, Phase 2).
 *
 * NOTE ON TYPING: the `TerminalSession`, `TerminalPolicy` and `TerminalApproval`
 * Prisma models are delivered as an INTEGRATION snippet (they cannot live in the
 * committed schema until migrated). To stay fully type-safe in the meantime, this
 * module declares the row shapes here and reaches the Prisma delegates through a
 * single narrowly-typed accessor (`models`). Once the schema migration lands,
 * `prisma.terminalSession` etc. exist and this accessor is a no-op cast.
 */

export type TermTargetKind = 'container' | 'nodeShell';
export type TermSessionReason =
  | 'exit'
  | 'idle_timeout'
  | 'killed'
  | 'agent_shutdown'
  | 'error'
  | 'closed';

export interface TerminalSessionRow {
  id: string;
  orgId: string;
  actorId: string;
  nodeId: string;
  targetKind: TermTargetKind;
  containerId: string | null;
  command: unknown;
  startedAt: Date;
  endedAt: Date | null;
  exitCode: number | null;
  reason: string | null;
  recordingRef: string | null;
  bytesIn: number;
  bytesOut: number;
  clientIp: string | null;
  approvedById: string | null;
}

export interface TerminalPolicyRow {
  orgId: string;
  containerExecEnabled: boolean;
  nodeShellEnabled: boolean;
  requireMfa: boolean;
  requireApprovalForNodeShell: boolean;
  recordContainerExec: boolean;
  idleTimeoutMs: number;
  maxSessionMs: number;
  allowedRoles: string[];
}

export interface TerminalApprovalRow {
  id: string;
  orgId: string;
  requestedById: string;
  nodeId: string;
  reason: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  approvedById: string | null;
  expiresAt: Date;
  createdAt: Date;
}

/** Safe org-scoped defaults — used when no policy row exists yet. */
export const DEFAULT_TERMINAL_POLICY: Omit<TerminalPolicyRow, 'orgId'> = {
  containerExecEnabled: true,
  nodeShellEnabled: false,
  requireMfa: true,
  requireApprovalForNodeShell: true,
  recordContainerExec: true,
  idleTimeoutMs: 300_000,
  maxSessionMs: 3_600_000,
  allowedRoles: ['owner', 'admin'],
};

interface CreateSessionInput {
  id: string;
  orgId: string;
  actorId: string;
  nodeId: string;
  targetKind: TermTargetKind;
  containerId?: string | null;
  command: unknown;
  recordingRef?: string | null;
  clientIp?: string | null;
  approvedById?: string | null;
}

interface CloseSessionInput {
  exitCode: number | null;
  reason: string;
  bytesIn: number;
  bytesOut: number;
  recordingRef?: string | null;
}

/**
 * The three Prisma delegates this feature needs, narrowed to the methods used.
 * A single cast confines the "model not yet generated" gap to one place.
 */
interface TerminalDelegates {
  terminalSession: {
    create(args: { data: Record<string, unknown> }): Promise<TerminalSessionRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<TerminalSessionRow>;
    findFirst(args: {
      where: Record<string, unknown>;
      select?: Record<string, boolean>;
    }): Promise<TerminalSessionRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
      take?: number;
    }): Promise<TerminalSessionRow[]>;
  };
  terminalPolicy: {
    findUnique(args: { where: { orgId: string } }): Promise<TerminalPolicyRow | null>;
    upsert(args: {
      where: { orgId: string };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    }): Promise<TerminalPolicyRow>;
  };
  terminalApproval: {
    create(args: { data: Record<string, unknown> }): Promise<TerminalApprovalRow>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<TerminalApprovalRow>;
    findFirst(args: { where: Record<string, unknown> }): Promise<TerminalApprovalRow | null>;
    findMany(args: {
      where: Record<string, unknown>;
      orderBy?: Record<string, 'asc' | 'desc'>;
    }): Promise<TerminalApprovalRow[]>;
  };
}

function models(db: DB): TerminalDelegates {
  return db as unknown as TerminalDelegates;
}

/** Load the org's terminal policy, merged over safe defaults. */
export async function getTerminalPolicy(db: DB, orgId: string): Promise<TerminalPolicyRow> {
  const row = await models(db).terminalPolicy.findUnique({ where: { orgId } });
  if (!row) return { orgId, ...DEFAULT_TERMINAL_POLICY };
  return {
    orgId,
    containerExecEnabled: row.containerExecEnabled ?? DEFAULT_TERMINAL_POLICY.containerExecEnabled,
    nodeShellEnabled: row.nodeShellEnabled ?? DEFAULT_TERMINAL_POLICY.nodeShellEnabled,
    requireMfa: row.requireMfa ?? DEFAULT_TERMINAL_POLICY.requireMfa,
    requireApprovalForNodeShell:
      row.requireApprovalForNodeShell ?? DEFAULT_TERMINAL_POLICY.requireApprovalForNodeShell,
    recordContainerExec: row.recordContainerExec ?? DEFAULT_TERMINAL_POLICY.recordContainerExec,
    idleTimeoutMs: row.idleTimeoutMs ?? DEFAULT_TERMINAL_POLICY.idleTimeoutMs,
    maxSessionMs: row.maxSessionMs ?? DEFAULT_TERMINAL_POLICY.maxSessionMs,
    allowedRoles: Array.isArray(row.allowedRoles)
      ? row.allowedRoles
      : DEFAULT_TERMINAL_POLICY.allowedRoles,
  };
}

export async function setTerminalPolicy(
  ctx: OrgContext,
  patch: Partial<Omit<TerminalPolicyRow, 'orgId'>>,
): Promise<TerminalPolicyRow> {
  const current = await getTerminalPolicy(ctx.db, ctx.activeOrgId);
  const next = { ...current, ...patch };
  await models(ctx.db).terminalPolicy.upsert({
    where: { orgId: ctx.activeOrgId },
    create: { ...next },
    update: { ...patch },
  });
  await writeAudit(ctx, { action: 'terminal.policy.set', targetType: 'org', targetId: ctx.activeOrgId, metadata: patch });
  return next;
}

export async function createTerminalSession(
  db: DB,
  input: CreateSessionInput,
): Promise<TerminalSessionRow> {
  return models(db).terminalSession.create({
    data: {
      id: input.id,
      orgId: input.orgId,
      actorId: input.actorId,
      nodeId: input.nodeId,
      targetKind: input.targetKind,
      containerId: input.containerId ?? null,
      command: (input.command ?? {}) as object,
      recordingRef: input.recordingRef ?? null,
      clientIp: input.clientIp ?? null,
      approvedById: input.approvedById ?? null,
      bytesIn: 0,
      bytesOut: 0,
    },
  });
}

export async function closeTerminalSession(
  db: DB,
  id: string,
  input: CloseSessionInput,
): Promise<void> {
  await models(db)
    .terminalSession.update({
      where: { id },
      data: {
        endedAt: new Date(),
        exitCode: input.exitCode,
        reason: input.reason,
        bytesIn: input.bytesIn,
        bytesOut: input.bytesOut,
        ...(input.recordingRef !== undefined ? { recordingRef: input.recordingRef } : {}),
      },
    })
    .catch(() => undefined);
}

/** Live + historical sessions for the org. Members see only their own. */
export async function listTerminalSessions(ctx: OrgContext): Promise<TerminalSessionRow[]> {
  const isAdmin = ctx.membership.role === 'owner' || ctx.membership.role === 'admin';
  return models(ctx.db).terminalSession.findMany({
    where: {
      orgId: ctx.activeOrgId,
      ...(isAdmin ? {} : { actorId: ctx.user.id }),
    },
    orderBy: { startedAt: 'desc' },
    take: 200,
  });
}

export async function getTerminalSession(
  ctx: OrgContext,
  id: string,
): Promise<TerminalSessionRow | null> {
  const row = await models(ctx.db).terminalSession.findFirst({
    where: { id, orgId: ctx.activeOrgId },
  });
  if (!row) return null;
  const isAdmin = ctx.membership.role === 'owner' || ctx.membership.role === 'admin';
  if (!isAdmin && row.actorId !== ctx.user.id) return null;
  return row;
}

export interface ApprovalDecision {
  /** Whether an active (approved, unexpired) grant exists for this user+node. */
  approved: boolean;
  approvalId: string | null;
}

/** Is there an active approval for this requester to open a node shell on a node? */
export async function activeNodeShellApproval(
  ctx: OrgContext,
  nodeId: string,
): Promise<ApprovalDecision> {
  const row = await models(ctx.db).terminalApproval.findFirst({
    where: {
      orgId: ctx.activeOrgId,
      requestedById: ctx.user.id,
      nodeId,
      status: 'approved',
      expiresAt: { gt: new Date() },
    },
  });
  return { approved: !!row, approvalId: row?.id ?? null };
}

export async function requestNodeShellApproval(
  ctx: OrgContext,
  input: { nodeId: string; reason: string; ttlMs?: number },
): Promise<TerminalApprovalRow> {
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? 15 * 60_000));
  const row = await models(ctx.db).terminalApproval.create({
    data: {
      orgId: ctx.activeOrgId,
      requestedById: ctx.user.id,
      nodeId: input.nodeId,
      reason: input.reason,
      status: 'pending',
      expiresAt,
    },
  });
  await writeAudit(ctx, {
    action: 'terminal.approval.request',
    targetType: 'node',
    targetId: input.nodeId,
    metadata: { approvalId: row.id, reason: input.reason },
  });
  return row;
}

export async function decideNodeShellApproval(
  ctx: OrgContext,
  input: { approvalId: string; approve: boolean },
): Promise<TerminalApprovalRow> {
  const row = await models(ctx.db).terminalApproval.update({
    where: { id: input.approvalId },
    data: { status: input.approve ? 'approved' : 'denied', approvedById: ctx.user.id },
  });
  await writeAudit(ctx, {
    action: input.approve ? 'terminal.approve' : 'terminal.deny',
    targetType: 'node',
    targetId: row.nodeId,
    metadata: { approvalId: row.id },
  });
  return row;
}

export async function listNodeShellApprovals(ctx: OrgContext): Promise<TerminalApprovalRow[]> {
  return models(ctx.db).terminalApproval.findMany({
    where: { orgId: ctx.activeOrgId },
    orderBy: { createdAt: 'desc' },
  });
}
