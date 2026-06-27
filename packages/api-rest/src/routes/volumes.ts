import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { deregisterClusterVolume, listClusterVolumes, registerClusterVolume } from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto, listEnvelope } from '../dto';
import { ClusterVolumeDto, RegisterVolumeBody } from '../dto-extra';
import { clusterVolumeToDto } from '../mappers-extra';
import { run } from '../respond';

const VolumeList = listEnvelope(ClusterVolumeDto, 'ClusterVolumeList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

/** Cluster (CSI) volumes — Swarm-scoped volumes that follow rescheduled tasks. */
export function registerVolumeRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get',
      path: '/volumes',
      tags: ['Volumes'],
      summary: 'List cluster volumes',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: VolumeList } }, description: 'Volumes' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listClusterVolumes(c.get('orgCtx'));
        return { data: rows.map(clusterVolumeToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/volumes',
      tags: ['Volumes'],
      summary: 'Register + provision a cluster volume',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(RegisterVolumeBody) },
      responses: {
        201: { content: { 'application/json': { schema: ClusterVolumeDto } }, description: 'Registered' },
        400: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return clusterVolumeToDto(
            await registerClusterVolume(c.get('orgCtx'), {
              name: b.name,
              csiDriver: b.csi_driver,
              accessMode: b.access_mode,
              capacityBytes: b.capacity_bytes,
              options: b.options,
              serviceId: b.service_id,
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/volumes/{id}',
      tags: ['Volumes'],
      summary: 'Deregister a cluster volume',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => deregisterClusterVolume(c.get('orgCtx'), c.req.param('id'))),
  );
}
