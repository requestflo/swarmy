import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import {
  addBackupTarget,
  backupVolume,
  listBackupTargets,
  listSnapshots,
  removeBackupTarget,
  restoreSnapshot,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireScope } from '../middleware';
import { ProblemDto, RemovedDto, listEnvelope } from '../dto';
import {
  AddBackupTargetBody,
  BackupRunDto,
  BackupTargetDto,
  BackupVolumeBody,
  RestoreResultDto,
  RestoreSnapshotBody,
  SnapshotDto,
} from '../dto-extra';
import {
  backupRunToDto,
  backupTargetToDto,
  restoreResultToDto,
  snapshotToDto,
} from '../mappers-extra';
import { run } from '../respond';

const BackupTargetList = listEnvelope(BackupTargetDto, 'BackupTargetList');
const SnapshotList = listEnvelope(SnapshotDto, 'SnapshotList');
const idParam = z.object({ id: z.string().openapi({ param: { name: 'id', in: 'path' } }) });
const problemRes = {
  content: { 'application/problem+json': { schema: ProblemDto } },
  description: 'Problem',
};
const jsonBody = <T extends z.ZodTypeAny>(schema: T) => ({
  content: { 'application/json': { schema } },
});

export function registerBackupRoutes(app: OpenAPIHono<RestEnv>): void {
  // ── targets ──────────────────────────────────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/backup-targets',
      tags: ['Backups'],
      summary: 'List backup targets',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      responses: {
        200: { content: { 'application/json': { schema: BackupTargetList } }, description: 'Targets' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const rows = await listBackupTargets(c.get('orgCtx'));
        return { data: rows.map(backupTargetToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/backup-targets',
      tags: ['Backups'],
      summary: 'Add a backup target (restic repo)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(AddBackupTargetBody) },
      responses: {
        201: { content: { 'application/json': { schema: BackupTargetDto } }, description: 'Created' },
        400: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return backupTargetToDto(
            await addBackupTarget(c.get('orgCtx'), {
              name: b.name,
              kind: b.kind,
              endpoint: b.endpoint,
              bucket: b.bucket,
              prefix: b.prefix,
              region: b.region,
              accessKeyId: b.access_key_id,
              secretAccessKey: b.secret_access_key,
              resticPassword: b.restic_password,
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/backup-targets/{id}',
      tags: ['Backups'],
      summary: 'Remove a backup target',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { params: idParam },
      responses: {
        200: { content: { 'application/json': { schema: RemovedDto } }, description: 'Removed' },
        404: problemRes,
      },
    }),
    (c) => run(c, () => removeBackupTarget(c.get('orgCtx'), c.req.param('id'))),
  );

  // ── snapshots: backup / list / restore ───────────────────────────────────
  app.openapi(
    createRoute({
      method: 'get',
      path: '/snapshots',
      tags: ['Backups'],
      summary: 'List snapshots',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('read')] as const,
      request: {
        query: z.object({
          volume: z.string().optional().openapi({ param: { name: 'volume', in: 'query' } }),
          target_id: z.string().optional().openapi({ param: { name: 'target_id', in: 'query' } }),
        }),
      },
      responses: {
        200: { content: { 'application/json': { schema: SnapshotList } }, description: 'Snapshots' },
        401: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const q = c.req.valid('query');
        const rows = await listSnapshots(c.get('orgCtx'), {
          volume: q.volume,
          targetId: q.target_id,
        });
        return { data: rows.map(snapshotToDto), next_cursor: null };
      }),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/snapshots',
      tags: ['Backups'],
      summary: 'Back up a volume now (creates a snapshot)',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(BackupVolumeBody) },
      responses: {
        201: { content: { 'application/json': { schema: BackupRunDto } }, description: 'Snapshot taken' },
        400: problemRes,
        404: problemRes,
      },
    }),
    (c) =>
      run(
        c,
        async () => {
          const b = c.req.valid('json');
          return backupRunToDto(
            await backupVolume(c.get('orgCtx'), {
              targetId: b.target_id,
              volume: b.volume,
              nodeId: b.node_id,
            }),
          );
        },
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/snapshots/restore',
      tags: ['Backups'],
      summary: 'Restore a snapshot into a volume',
      security: [{ bearerApiKey: [] }],
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(RestoreSnapshotBody) },
      responses: {
        200: { content: { 'application/json': { schema: RestoreResultDto } }, description: 'Restored' },
        404: problemRes,
      },
    }),
    (c) =>
      run(c, async () => {
        const b = c.req.valid('json');
        return restoreResultToDto(
          await restoreSnapshot(c.get('orgCtx'), {
            snapshotId: b.snapshot_id,
            targetVolume: b.target_volume,
            nodeId: b.node_id,
          }),
        );
      }),
  );
}
