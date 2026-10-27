import { authRegistry } from '@swarmy/auth';
import { bytesWords, DOWNLOAD_MAX_ENV, parseDownloadMaxBytes } from '@swarmy/core';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { prisma } from '@swarmy/db';
import { writeAudit } from '@swarmy/trpc';
// Not '../gateway': the hub imports this module, so that would be a cycle.
import { registry, store } from '../gateway/instances';
import { DownloadHub } from './download-hub';
import { handleBackupDownload } from './route';
import { bufferedDownloadBudget, controllerMemoryBytes, maxLiveDownloads, runtimeHoldsResponseBackpressure } from './runtime';

let maxLive = maxLiveDownloads(Bun.version);
if (!runtimeHoldsResponseBackpressure(Bun.version)) {
  // This Bun holds a slow download in memory, so size the cap and the number
  // at once to this controller's memory. The default cap is what tickets are
  // minted with (trpc reads the env on every mint); an operator's is kept.
  const set = process.env[DOWNLOAD_MAX_ENV]?.trim() ? parseDownloadMaxBytes(process.env[DOWNLOAD_MAX_ENV]) : null;
  const budget = bufferedDownloadBudget(controllerMemoryBytes(), set);
  if (set === null) process.env[DOWNLOAD_MAX_ENV] = String(budget.cap);
  maxLive = budget.maxLive;
  // eslint-disable-next-line no-console
  console.warn(
    `[downloads] Bun ${Bun.version} buffers a streamed response whatever the browser's speed, so a slow backup download is held in controller memory: ${maxLive} at once, each up to ${bytesWords(budget.cap)}${set === null ? ' (sized to this controller\'s memory)' : ''}. Bun 1.4+ streams at the browser's pace.`,
  );
}

/** The controller's one download hub (snapshot downloads, board 16). */
export const downloadHub = new DownloadHub({
  maxLive,
  send: (nodeId, type, payload) =>
    registry.send(nodeId, { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), type, payload }),
  isOnline: (nodeId) => registry.isOnline(nodeId),
  capabilities: (nodeId) => store.agentBuild.get(nodeId)?.capabilities,
  audit: (c, outcome, bytes, error) =>
    void writeAudit(
      { db: prisma, activeOrgId: c.orgId, user: { id: c.userId } } as never,
      {
        action: 'backup.download.finish',
        targetType: 'snapshot',
        targetId: c.audit.snapshotId,
        actorType: 'user',
        actorId: c.userId,
        metadata: { downloadId: c.downloadId, volume: c.audit.volume, path: c.audit.path, outcome, bytes, error },
      },
    ),
});

const sweeper = setInterval(() => downloadHub.sweep(), 30_000);
(sweeper as { unref?: () => void }).unref?.();

/** `GET /api/backups/download` with the live session + hub. */
export function serveBackupDownload(req: Request): Promise<Response> {
  return handleBackupDownload(req, {
    sessionUserId: async (headers) => (await authRegistry.getAuth().api.getSession({ headers }))?.user?.id ?? null,
    open: (ticket, userId) => downloadHub.open(ticket, userId),
  });
}
