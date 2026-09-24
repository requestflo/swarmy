import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { disableReplication, enableReplication, getStoreStatus, moveController } from '../services/controllerStore.service';

/**
 * Controller store (resilience P3): control.db replication and the movable
 * controller. Platform-level, like controllerBackup: status and replication
 * settings are admin-only. Moving the controller is a controlled failover of
 * the control plane (a restart plus a loss window of about 0 to 1 s), so it
 * is gated by the `data.failover` action.
 */
export const controllerStoreRouter = router({
  status: adminProcedure.query(({ ctx }) => getStoreStatus(ctx)),

  enableReplication: adminProcedure
    .input(
      z.object({
        target: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('garage') }),
          z.object({ kind: z.literal('backup-target'), targetId: z.string().min(1) }),
        ]),
      }),
    )
    .mutation(({ ctx, input }) => enableReplication(ctx, input)),

  disableReplication: adminProcedure.mutation(({ ctx }) => disableReplication(ctx)),

  move: abacProcedure('data.failover')
    .input(z.object({ swarmNodeId: z.string().min(1) }))
    .mutation(({ ctx, input }) => moveController(ctx, input)),
});
