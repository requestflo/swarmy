import {
  DB_MEMORY_LABEL,
  PG_MEMORY_MAX_MB,
  PG_MEMORY_MIN_MB,
  dbStorageState,
  isPgMemoryMb,
  parseMemoryMb,
  pgMemorySettings,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { badRequest, commandRejected, mapDispatchError } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';
import { liveCluster } from './manageddb-extensions.service';

/**
 * A managed Postgres cluster's memory (board 39, "Version & size · Memory").
 * The mutation only rewrites the primary's `swarmy.db.memoryMb` label; the
 * manageddb reconcile converges it (`planPgMemory`: each standby restarts with
 * the new limit, then the writer in place), and `applyPgMember` sizes
 * shared_buffers (25%) and effective_cache_size (75%) from it on every
 * rebuild. Docker is the truth; no DB rows.
 */

export interface SetDbMemoryInput {
  stack: string;
  cluster: string;
  /** MB per copy; null removes the limit. */
  memoryMb: number | null;
}

export interface SetDbMemoryResult {
  stack: string;
  cluster: string;
  memoryMb: number | null;
  changed: boolean;
  sharedBuffersMb: number | null;
  effectiveCacheSizeMb: number | null;
  /** How many copies the reconcile restarts (standbys first, then the writer). */
  restarts: number;
}

export async function setDbMemory(ctx: OrgContext, input: SetDbMemoryInput): Promise<SetDbMemoryResult> {
  const { primary, standbys, writers } = liveCluster(ctx, input.stack, input.cluster);
  if (input.memoryMb !== null && !isPgMemoryMb(input.memoryMb)) {
    throw badRequest(`memory must be a whole number of MB between ${PG_MEMORY_MIN_MB} and ${PG_MEMORY_MAX_MB}`);
  }
  const settings = input.memoryMb === null ? null : pgMemorySettings(input.memoryMb);
  const copies = [primary, ...writers, ...standbys].reduce((n, s) => n + Math.max(1, s.desiredReplicas ?? 1), 0);
  const result = {
    stack: input.stack,
    cluster: input.cluster,
    memoryMb: input.memoryMb,
    sharedBuffersMb: settings?.sharedBuffersMb ?? null,
    effectiveCacheSizeMb: settings?.effectiveCacheSizeMb ?? null,
    restarts: copies,
  };
  const current = parseMemoryMb(primary.labels[DB_MEMORY_LABEL]);
  if (current === input.memoryMb) return { ...result, changed: false };
  if (dbStorageState(primary).state !== 'persistent') {
    throw commandRejected(`a new memory limit restarts the database, and ${input.cluster} keeps its data on a temporary volume; migrate its storage first`);
  }

  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: input.memoryMb === null ? {} : { [DB_MEMORY_LABEL]: String(input.memoryMb) },
      removeKeys: input.memoryMb === null ? [DB_MEMORY_LABEL] : [],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: 'db.memory.set',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: {
      primary: primary.name,
      fromMb: current,
      toMb: input.memoryMb,
      sharedBuffersMb: result.sharedBuffersMb,
      effectiveCacheSizeMb: result.effectiveCacheSizeMb,
      restarts: copies,
    },
  });
  return { ...result, changed: true };
}
