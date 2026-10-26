/**
 * Reindex by swap (board 41): swap a rebuilt index in for the live one with
 * Meilisearch's `POST /swap-indexes`, run inside the engine container like
 * every other index call (search-indexes.service.ts). swarmy doesn't hold the
 * app's data, so the rebuild is the app's (a job writing every document into
 * a second index); swarmy checks it is safe to swap (`swapProblem`: not empty,
 * not still filling, keyed the same way), swaps atomically and waits a few
 * seconds for the engine's task. The old documents stay under the other
 * name. Typed confirmation (the live index's name). Router gate:
 * `stack.deploy` on the stack, as a settings edit. Audited
 * `search.index.swap`, whatever the outcome.
 */
import { swapProblem, type SearchSwapResult, type SwapSearchIndexInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { searchBaseName } from './search.service';
import { indexPath, meiliProblem, meiliScript, meiliSwapScript } from './search-indexes.core';
import { indexView, parseTask } from './search-indexes.parse';
import { assertOk, meiliInstance, newMarker, runInEngine } from './search-indexes.service';

const STATUSES = ['succeeded', 'failed', 'processing', 'enqueued', 'canceled'] as const;
const asStatus = (s: string | null): SearchSwapResult['status'] =>
  (STATUSES as readonly string[]).includes(s ?? '') ? (s as SearchSwapResult['status']) : 'enqueued';

export async function swapSearchIndex(ctx: OrgContext, input: SwapSearchIndexInput): Promise<SearchSwapResult> {
  if (input.confirm !== input.index) throw commandRejected(`type ${input.index} to swap it`);
  const i = meiliInstance(ctx, input);
  const audit = (metadata: Record<string, unknown>): Promise<void> =>
    writeAudit(ctx, {
      action: 'search.index.swap',
      targetType: 'searchInstance',
      targetId: searchBaseName(input.stack, input.name),
      metadata: { index: input.index, with: input.with, ...metadata },
    });

  // Both sides as the engine has them now.
  const m1 = newMarker();
  const reads = await runInEngine(
    ctx,
    i,
    meiliScript(
      [
        { method: 'GET', path: indexPath(input.index) },
        { method: 'GET', path: indexPath(input.index, '/stats') },
        { method: 'GET', path: indexPath(input.with) },
        { method: 'GET', path: indexPath(input.with, '/stats') },
      ],
      m1,
    ),
    m1,
  );
  assertOk(reads, 4, `${input.stack}/${input.name}/${input.index} or ${input.with}`);
  const live = indexView(reads[0]?.body, reads[1]?.body);
  const next = indexView(reads[2]?.body, reads[3]?.body);
  const problem = swapProblem(live, next);
  if (problem) {
    await audit({ status: 'refused', error: problem });
    throw commandRejected(problem);
  }

  const m2 = newMarker();
  const rs = await runInEngine(ctx, i, meiliSwapScript(m2), m2, JSON.stringify([{ indexes: [input.index, input.with] }]));
  const refused = meiliProblem(rs[0]);
  if (refused) {
    await audit({ status: 'refused', error: refused.message });
    if (refused.kind === 'notFound') throw notFound('search index', `${input.stack}/${input.name}/${input.with}`);
    throw commandRejected(refused.message);
  }
  const enqueued = parseTask(rs[0]?.body);
  const last = rs[1] && !meiliProblem(rs[1]) ? parseTask(rs[1].body) : null;
  const result: SearchSwapResult = {
    index: input.index,
    with: input.with,
    taskUid: enqueued.taskUid,
    status: asStatus(last?.status ?? enqueued.status),
    error: last?.error ?? null,
  };
  await audit({ taskUid: result.taskUid, status: result.status, error: result.error, docs: { [input.index]: live.docs, [input.with]: next.docs } });
  if (result.status === 'failed') throw commandRejected(result.error ?? 'the engine refused the swap');
  return result;
}
