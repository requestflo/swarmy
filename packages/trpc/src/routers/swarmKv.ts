import { z } from 'zod';
import { adminProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import { resolveConfigRow } from '../abac-config';
import { kvDocVersions, listKvDocs, revertKvDoc } from '../services/swarm-kv-versions.service';

/**
 * swarm-kv (plans/epic-docker-native-state.md §2b): the org's infra config
 * documents held in the swarm's raft, their retained versions, and "put back
 * an earlier version". Reads are admin-only (platform level, like
 * controllerStore). Putting a version back changes live config the
 * reconcilers converge on, so it is policy-gated as `data.restore` (the
 * closest existing action: restoring config over what is live; admin-only by
 * default) and audited `swarmkv.revert` by the service.
 */
const key = z.object({ collection: z.string().min(1).max(12), id: z.string().min(1).max(40) });

export const swarmKvRouter = router({
  list: adminProcedure.query(({ ctx }) => listKvDocs(ctx)),

  versions: adminProcedure.input(key).query(({ ctx, input }) => kvDocVersions(ctx, input)),

  revert: abacProcedure('data.restore', resolveConfigRow('kvDoc'))
    .input(key.extend({ seq: z.number().int().positive() }))
    .mutation(({ ctx, input }) => revertKvDoc(ctx, input)),
});
