/**
 * Import from Heroku, the data step: a one-shot copy of a Heroku Postgres
 * into the managed one Deploy started. Separate from Deploy and explicit:
 * the caller types `<stack>/<cluster>` (as removing a database does), the
 * copy only goes into an empty database, and Heroku is only read.
 *
 * The Heroku URL is read again here (the token, or the pasted config, comes
 * with the call and is never stored); its password and the target's ride a
 * 0600 passfile in the one-shot container, never env or argv (pg-copy.ts).
 */
import { TRPCError } from '@trpc/server';
import { herokuCopyPhrase, PG_ENV, type HerokuImportCopyInput } from '@swarmy/core';
import type { RunOnceResult } from '@swarmy/core/protocol';
import type { OrgContext } from '../../context';
import { writeAudit } from '../audit.service';
import { clusterNetworkName, primaryServiceName, readDbPassword, runningTaskOf } from '../manageddb.service';
import { COPY_TIMEOUT_MS, herokuCopyPayload, parsePgUrl, readCopyOutcome, type CopyOutcome } from './pg-copy';
import { resolveHeroku } from './source';

const refuse = (message: string): TRPCError => new TRPCError({ code: 'PRECONDITION_FAILED', message });

export interface HerokuCopyResult extends CopyOutcome {
  stack: string;
  cluster: string;
}

export async function copyHerokuDatabase(ctx: OrgContext, input: HerokuImportCopyInput, resolve = resolveHeroku): Promise<HerokuCopyResult> {
  const { stack, cluster } = input;
  if (input.confirm.trim() !== herokuCopyPhrase(stack, cluster)) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: `Type ${herokuCopyPhrase(stack, cluster)} to copy the data.` });
  }
  const r = await resolve(input.source, stack);
  const db = r.conv.databases.find((d) => d.resource === cluster);
  if (!db) throw refuse(`The import has no database called ${cluster}.`);
  const src = parsePgUrl(r.config[db.envVar] ?? '');
  if (!src) throw refuse(`${db.envVar} isn’t in the Heroku config (or isn’t a postgres:// URL), so there is nothing to copy from.`);

  const primaryName = primaryServiceName(stack, cluster);
  const primary = ctx.hub.liveInventory(ctx.activeOrgId).services.find((s) => s.name === primaryName);
  if (!primary) throw refuse(`${cluster} isn’t running yet: press Deploy first.`);
  const task = runningTaskOf(ctx, primary);
  if (!task) throw refuse(`${cluster} has no running copy right now. Wait for it to start, then copy.`);
  const env = Object.fromEntries((primary.env ?? []).map((kv) => [kv.split('=')[0], kv.slice(kv.indexOf('=') + 1)]));
  const targetPassword = await readDbPassword(ctx, stack, cluster);
  const payload = herokuCopyPayload({
    image: primary.image,
    network: clusterNetworkName(stack, cluster),
    primaryService: primaryName,
    database: env[PG_ENV.database] || 'app',
    src,
    targetPassword,
  });

  const started = Date.now();
  const res = await ctx.hub
    .dispatch<RunOnceResult>(task.nodeId, 'container.runOnce', payload, { timeoutMs: COPY_TIMEOUT_MS + 60_000 })
    .catch((e: unknown) => ({ exitCode: -1, output: e instanceof Error ? e.message : String(e) }));
  const outcome = readCopyOutcome(res, cluster);
  await writeAudit(ctx, {
    action: 'heroku.import.copy',
    targetType: 'dbCluster',
    targetId: `${stack}/${cluster}`,
    // The source by host only: never its user, password or database name.
    metadata: { source: input.source.kind, herokuApp: r.herokuApp, from: src.host, status: outcome.status, tables: outcome.tables, ms: Date.now() - started },
  });
  return { stack, cluster, ...outcome };
}
