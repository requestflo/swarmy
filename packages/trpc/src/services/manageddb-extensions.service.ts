import {
  DB_EXTENSIONS_AVAILABLE_LABEL,
  DB_EXTENSIONS_ERROR_LABEL,
  DB_EXTENSIONS_LABEL,
  PG_EXTENSION_CATALOG,
  STACK_LABEL,
  dbStorageState,
  encodeExtList,
  parseExtList,
  type PgExtensionName,
} from '@swarmy/core';
import type { SwarmServiceInfo } from '@swarmy/core/protocol';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveManagerNode } from './dispatch.service';

/**
 * Managed Postgres extension toggles (board 39): pg_stat_statements and
 * postgis. The mutation only rewrites the primary's `swarmy.db.extensions`
 * label; the manageddb reconcile converges it (`planPgExtensions`: standbys
 * restart first, then the writer in place, then CREATE EXTENSION). The view
 * is `manageddb-extensions-view.ts`. Docker is the truth; no DB rows.
 */

export interface ExtLive {
  primary: SwarmServiceInfo;
  standbys: SwarmServiceInfo[];
  writers: SwarmServiceInfo[];
}

export function liveCluster(ctx: OrgContext, stack: string, cluster: string): ExtLive {
  const mine = ctx.hub.liveInventory(ctx.activeOrgId).services.filter(
    (s) =>
      (s.labels[STACK_LABEL] ?? '') === stack &&
      s.labels['swarmy.db.cluster'] === cluster &&
      s.labels['swarmy.db.engine'] === 'postgres' &&
      s.labels['swarmy.db.walShipper'] !== 'true',
  );
  const primary = mine.find((s) => s.labels['swarmy.db.role'] === 'primary' && !s.labels['swarmy.db.member']);
  if (!primary) throw notFound('db cluster primary', `${stack}/${cluster}`);
  return {
    primary,
    standbys: mine.filter((s) => s.labels['swarmy.db.role'] === 'replica'),
    writers: mine.filter((s) => s.labels['swarmy.db.role'] === 'primary' && s.labels['swarmy.db.member']),
  };
}

export function availableOf(primary: SwarmServiceInfo): PgExtensionName[] | null {
  const raw = primary.labels[DB_EXTENSIONS_AVAILABLE_LABEL];
  return raw === undefined ? null : parseExtList(raw);
}

export interface SetDbExtensionInput {
  stack: string;
  cluster: string;
  name: PgExtensionName;
  on: boolean;
}

/** Declare an extension on or off; the reconcile does the rest. Audited `db.extension.enable|disable`. */
export async function setDbExtension(
  ctx: OrgContext,
  input: SetDbExtensionInput,
): Promise<{ stack: string; cluster: string; name: PgExtensionName; on: boolean; changed: boolean; restartsCopies: boolean }> {
  const { primary } = liveCluster(ctx, input.stack, input.cluster);
  const entry = PG_EXTENSION_CATALOG[input.name];
  const restartsCopies = entry.preload !== null;
  const wanted = parseExtList(primary.labels[DB_EXTENSIONS_LABEL]);
  const result = { stack: input.stack, cluster: input.cluster, name: input.name, on: input.on, restartsCopies };
  if (wanted.includes(input.name) === input.on) return { ...result, changed: false };

  if (input.on) {
    const available = availableOf(primary);
    const ships = available === null ? entry.contrib : available.includes(input.name);
    if (!ships) {
      throw commandRejected(
        available === null
          ? `swarmy hasn't checked ${primary.image} for ${input.name} yet; try again in a minute`
          : `${input.name} isn't in ${primary.image}; it needs a ${input.name} image (for example postgis/postgis:17-3.5)`,
      );
    }
    if (restartsCopies && dbStorageState(primary).state !== 'persistent') {
      throw commandRejected(`${input.name} restarts the database, and ${input.cluster} keeps its data on a temporary volume; migrate its storage first`);
    }
  } else if (!entry.canDisable) {
    throw commandRejected(`${input.name} can't be turned off here: DROP EXTENSION would drop every column that uses it`);
  }

  const next = encodeExtList(input.on ? [...wanted, input.name] : wanted.filter((n) => n !== input.name));
  try {
    const node = await resolveManagerNode(ctx);
    await ctx.hub.dispatch(node.id, 'service.updateLabels', {
      service: primary.name,
      add: next ? { [DB_EXTENSIONS_LABEL]: next } : {},
      removeKeys: next ? [DB_EXTENSIONS_ERROR_LABEL] : [DB_EXTENSIONS_ERROR_LABEL, DB_EXTENSIONS_LABEL],
    });
  } catch (e) {
    throw mapDispatchError(e);
  }
  await writeAudit(ctx, {
    action: input.on ? 'db.extension.enable' : 'db.extension.disable',
    targetType: 'dbCluster',
    targetId: `${input.stack}/${input.cluster}`,
    metadata: { extension: input.name, primary: primary.name, restartsCopies, wanted: next },
  });
  return { ...result, changed: true };
}
