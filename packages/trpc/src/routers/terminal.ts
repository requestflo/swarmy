import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, orgProcedure } from '../trpc';
import { notFound } from '../errors';
import { writeAudit } from '../services/audit.service';

/**
 * Terminal control plane. RBAC + target resolution + audit; mints a single-use
 * ticket the browser exchanges on the `/term/ws` data plane (apps/api). The
 * agent-side `SWARMY_ALLOW_EXEC` gate is authoritative for whether a shell opens.
 */
export const terminalRouter = router({
  open: orgProcedure
    .input(z.object({ serviceId: z.string() }))
    .mutation(async ({ ctx, input }) => {
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
      const match =
        containers.find((c) => c.name?.includes(svc.name)) ?? containers[0];
      if (!match) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'no running container found on the node' });
      }

      const sessionId = crypto.randomUUID();
      const { ticket } = ctx.hub.mintTerminalTicket({
        sessionId,
        nodeId,
        orgId: ctx.activeOrgId,
        userId: ctx.user.id,
        target: { kind: 'container', containerId: match.id, cmd: [] },
      });

      await writeAudit(ctx, {
        action: 'terminal.request',
        targetType: 'service',
        targetId: svc.id,
        metadata: { nodeId, containerId: match.id, sessionId },
      });

      return { sessionId, ticket };
    }),
});
