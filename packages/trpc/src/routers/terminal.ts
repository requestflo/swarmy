import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, orgProcedure, adminProcedure } from '../trpc';
import { notFound } from '../errors';
import { writeAudit } from '../services/audit.service';
import { abacProcedure, type ResolveResource } from '../abac';
import type { OrgContext } from '../context';
import {
  getTerminalPolicy,
  setTerminalPolicy,
  createTerminalSession,
  listTerminalSessions,
  getTerminalSession,
  activeNodeShellApproval,
  requestNodeShellApproval,
  decideNodeShellApproval,
  listNodeShellApprovals,
  closeTerminalSession,
} from '../services/terminal.service';
import { readRecording } from '../services/terminal-recording-read';

/**
 * Terminal control plane (epic #11). The single place RBAC/ABAC/policy/approval
 * is enforced. tRPC = control plane (typed, audited, policy); `/term/ws` (in
 * apps/api) = data plane (bytes).
 *
 * Both `open` (container exec) and `openNodeShell` are gated by the ABAC action
 * `terminal.open` (so org policies + the audit trail govern who may open a
 * shell at all — denies are audited as `authz.deny:terminal.open`). On top of
 * ABAC, the org `TerminalPolicy` adds: allowedRoles, container-exec/node-shell
 * enable toggles, node-shell approval (four-eyes break-glass), and recording.
 *
 * Optional approval flag (documented): when `TerminalPolicy.requireApprovalFor
 * NodeShell` is true (the default), `openNodeShell` requires an active, approved,
 * unexpired `TerminalApproval` for the requester+node — otherwise it fails with
 * a typed `NEEDS_APPROVAL` error and the UI shows a "Request access" button.
 */

/** Resolve the service's node as the ABAC resource for container exec. */
const resolveServiceNode: ResolveResource = async (ctx, input) => {
  const serviceId = (input as { serviceId?: string })?.serviceId;
  if (!serviceId) return null;
  const svc = await ctx.db.service.findFirst({
    where: { id: serviceId, orgId: ctx.activeOrgId },
    select: { id: true, nodeId: true },
  });
  if (!svc?.nodeId) return null;
  const node = await ctx.db.node.findFirst({
    where: { id: svc.nodeId, orgId: ctx.activeOrgId },
    select: { id: true, orgId: true, labels: true },
  });
  if (!node) return null;
  return { type: 'node', id: node.id, orgId: node.orgId, labels: (node.labels as Record<string, unknown>) ?? {} };
};

/** Resolve a Node from `{ nodeId }` for node-shell. */
const resolveNodeFromNodeId: ResolveResource = async (ctx, input) => {
  const nodeId = (input as { nodeId?: string })?.nodeId;
  if (!nodeId) return null;
  const node = await ctx.db.node.findFirst({
    where: { id: nodeId, orgId: ctx.activeOrgId },
    select: { id: true, orgId: true, labels: true },
  });
  if (!node) return null;
  return { type: 'node', id: node.id, orgId: node.orgId, labels: (node.labels as Record<string, unknown>) ?? {} };
};

function assertAllowedRole(ctx: OrgContext, allowedRoles: string[]): void {
  if (!allowedRoles.includes(ctx.membership.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: `your role (${ctx.membership.role}) may not open terminals`,
      cause: { swarmyCode: 'ROLE_NOT_ALLOWED' },
    });
  }
}

/** Best-effort hub kill (the WS teardown lives in apps/api; see INTEGRATION). */
function tryKillSession(ctx: OrgContext, sessionId: string): void {
  const hub = ctx.hub as unknown as { killTerminalSession?: (id: string) => boolean };
  hub.killTerminalSession?.(sessionId);
}

export const terminalRouter = router({
  /** Container exec: open a shell in the service's container. ABAC-gated. */
  open: abacProcedure('terminal.open', resolveServiceNode)
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const policy = await getTerminalPolicy(ctx.db, ctx.activeOrgId);
      if (!policy.containerExecEnabled) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'container exec is disabled for this org' });
      }
      assertAllowedRole(ctx, policy.allowedRoles);

      const svc = await ctx.db.service.findFirst({
        where: { id: input.serviceId, orgId: ctx.activeOrgId },
        select: { id: true, name: true, nodeId: true },
      });
      if (!svc) throw notFound('service', input.serviceId);

      const nodeId = svc.nodeId ?? ctx.hub.onlineNodeIds()[0];
      if (!nodeId || !ctx.hub.isOnline(nodeId)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'no online node for this service' });
      }

      const containers = ctx.hub.latestContainers(nodeId);
      const match = containers.find((c) => c.name?.includes(svc.name)) ?? containers[0];
      if (!match) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'no running container found on the node' });
      }

      const sessionId = crypto.randomUUID();
      const target = { kind: 'container' as const, containerId: match.id, cmd: [] as string[] };
      const { ticket } = ctx.hub.mintTerminalTicket({
        sessionId,
        nodeId,
        orgId: ctx.activeOrgId,
        userId: ctx.user.id,
        target,
      });

      await createTerminalSession(ctx.db, {
        id: sessionId,
        orgId: ctx.activeOrgId,
        actorId: ctx.user.id,
        nodeId,
        targetKind: 'container',
        containerId: match.id,
        command: target,
      });

      await writeAudit(ctx, {
        action: 'terminal.open',
        targetType: 'service',
        targetId: svc.id,
        metadata: { nodeId, containerId: match.id, sessionId, kind: 'container' },
      });

      return { sessionId, ticket };
    }),

  /** Node shell (host RCE): strictest path. ABAC + policy + approval. */
  openNodeShell: abacProcedure('terminal.open', resolveNodeFromNodeId)
    .input(z.object({ nodeId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const policy = await getTerminalPolicy(ctx.db, ctx.activeOrgId);
      if (!policy.nodeShellEnabled) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'node shell is disabled for this org (enable in Security → Terminal)',
          cause: { swarmyCode: 'NODE_SHELL_DISABLED' },
        });
      }
      assertAllowedRole(ctx, policy.allowedRoles);

      const node = await ctx.db.node.findFirst({
        where: { id: input.nodeId, orgId: ctx.activeOrgId },
        select: { id: true },
      });
      if (!node) throw notFound('node', input.nodeId);
      if (!ctx.hub.isOnline(node.id)) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'node is offline' });
      }

      // Four-eyes break-glass: require an active approval if policy demands it.
      let approvalId: string | null = null;
      if (policy.requireApprovalForNodeShell) {
        const decision = await activeNodeShellApproval(ctx, node.id);
        if (!decision.approved) {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'node-shell access requires approval',
            cause: { swarmyCode: 'NEEDS_APPROVAL' },
          });
        }
        approvalId = decision.approvalId;
      }

      const sessionId = crypto.randomUUID();
      const target = { kind: 'nodeShell' as const, cmd: [] as string[] };
      const { ticket } = ctx.hub.mintTerminalTicket({
        sessionId,
        nodeId: node.id,
        orgId: ctx.activeOrgId,
        userId: ctx.user.id,
        target,
      });

      await createTerminalSession(ctx.db, {
        id: sessionId,
        orgId: ctx.activeOrgId,
        actorId: ctx.user.id,
        nodeId: node.id,
        targetKind: 'nodeShell',
        command: target,
        approvedById: approvalId,
      });

      await writeAudit(ctx, {
        action: 'terminal.open',
        targetType: 'node',
        targetId: node.id,
        metadata: { nodeId: node.id, sessionId, kind: 'nodeShell', approvalId },
      });

      return { sessionId, ticket };
    }),

  /** Live + historical sessions (admins all; members own). */
  list: orgProcedure.query(({ ctx }) => listTerminalSessions(ctx)),

  get: orgProcedure
    .input(z.object({ id: z.string() }))
    .query(async ({ ctx, input }) => {
      const row = await getTerminalSession(ctx, input.id);
      if (!row) throw notFound('terminal session', input.id);
      return row;
    }),

  /** Owner/admin may kill any session; a user may close their own. */
  close: orgProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const row = await getTerminalSession(ctx, input.id);
      if (!row) throw notFound('terminal session', input.id);
      // Signal the data plane to tear down the live socket (best-effort; the WS
      // kill is wired via the hub — see INTEGRATION). Then finalize the row so
      // the close is durable even if no live socket exists.
      tryKillSession(ctx, input.id);
      if (!row.endedAt) {
        await closeTerminalSession(ctx.db, input.id, {
          exitCode: null,
          reason: 'killed',
          bytesIn: row.bytesIn,
          bytesOut: row.bytesOut,
        });
      }
      await writeAudit(ctx, {
        action: 'terminal.kill',
        targetType: row.targetKind === 'container' ? 'container' : 'node',
        targetId: row.containerId ?? row.nodeId,
        metadata: { sessionId: input.id },
      });
      return { ok: true };
    }),

  /** Asciicast for replay. RBAC: admins/owner, or the actor. */
  recording: router({
    get: orgProcedure
      .input(z.object({ id: z.string() }))
      .query(async ({ ctx, input }) => {
        const row = await getTerminalSession(ctx, input.id);
        if (!row) throw notFound('terminal session', input.id);
        if (!row.recordingRef) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'no recording for this session' });
        }
        const cast = await readRecording(row.recordingRef);
        if (cast == null) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'recording file is missing' });
        }
        return { cast };
      }),
  }),

  /** Org terminal policy (toggles). Admin-only. */
  policy: router({
    get: adminProcedure.query(({ ctx }) => getTerminalPolicy(ctx.db, ctx.activeOrgId)),
    set: adminProcedure
      .input(
        z.object({
          containerExecEnabled: z.boolean().optional(),
          nodeShellEnabled: z.boolean().optional(),
          requireMfa: z.boolean().optional(),
          requireApprovalForNodeShell: z.boolean().optional(),
          recordContainerExec: z.boolean().optional(),
          idleTimeoutMs: z.number().int().positive().optional(),
          maxSessionMs: z.number().int().positive().optional(),
          allowedRoles: z.array(z.enum(['owner', 'admin', 'member'])).optional(),
        }),
      )
      .mutation(({ ctx, input }) => setTerminalPolicy(ctx, input)),
  }),

  /** Node-shell break-glass approvals. */
  approval: router({
    request: orgProcedure
      .input(z.object({ nodeId: z.string(), reason: z.string().min(1), ttlMs: z.number().int().positive().optional() }))
      .mutation(({ ctx, input }) => requestNodeShellApproval(ctx, input)),
    list: adminProcedure.query(({ ctx }) => listNodeShellApprovals(ctx)),
    decide: adminProcedure
      .input(z.object({ approvalId: z.string(), approve: z.boolean() }))
      .mutation(({ ctx, input }) => decideNodeShellApproval(ctx, input)),
  }),
});
