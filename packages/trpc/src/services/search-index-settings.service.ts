/**
 * Edit an index's searchable fields, filters and synonyms (board 41) with one
 * `PATCH /indexes/{uid}/settings`, run inside the engine container like every
 * other index call (search-indexes.service.ts). Only the lists given are
 * sent, so the rest of the index's settings are left as they are. The engine
 * re-indexes in the background; swarmy waits a few seconds for its task and
 * says where it got to. Router gate: `stack.deploy` on the stack. Audited
 * `search.index.settings`, whatever the outcome.
 */
import type { SearchSettingsResult, SetIndexSettingsInput } from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { searchBaseName } from './search.service';
import { meiliProblem, meiliSettingsScript } from './search-indexes.core';
import { parseTask } from './search-indexes.parse';
import { meiliInstance, newMarker, runInEngine } from './search-indexes.service';

type Changed = SearchSettingsResult['changed'];

/** PURE — the PATCH body: only the lists given; an empty searchable list means every field. */
export function settingsBody(input: SetIndexSettingsInput): { body: Record<string, unknown>; changed: Changed } {
  const body: Record<string, unknown> = {};
  const changed: Changed = [];
  if (input.searchable) {
    const list = [...new Set(input.searchable.map((a) => a.trim()).filter(Boolean))];
    body.searchableAttributes = list.length ? list : ['*'];
    changed.push('searchable');
  }
  if (input.filterable) {
    body.filterableAttributes = [...new Set(input.filterable.map((a) => a.trim()).filter(Boolean))];
    changed.push('filterable');
  }
  if (input.synonyms) {
    body.synonyms = input.synonyms;
    changed.push('synonyms');
  }
  return { body, changed };
}

const STATUSES = ['succeeded', 'failed', 'processing', 'enqueued', 'canceled'] as const;
const asStatus = (s: string | null): SearchSettingsResult['status'] =>
  (STATUSES as readonly string[]).includes(s ?? '') ? (s as SearchSettingsResult['status']) : 'enqueued';

export async function setSearchIndexSettings(ctx: OrgContext, input: SetIndexSettingsInput): Promise<SearchSettingsResult> {
  const { body, changed } = settingsBody(input);
  if (changed.length === 0) throw commandRejected('nothing to change — give searchable, filterable or synonyms');
  const i = meiliInstance(ctx, input);
  const marker = newMarker();
  const rs = await runInEngine(ctx, i, meiliSettingsScript(input.index, marker), marker, JSON.stringify(body));
  const audit = (metadata: Record<string, unknown>): Promise<void> =>
    writeAudit(ctx, {
      action: 'search.index.settings',
      targetType: 'searchInstance',
      targetId: searchBaseName(input.stack, input.name),
      metadata: {
        index: input.index,
        changed,
        searchable: input.searchable?.length,
        filterable: input.filterable?.length,
        synonymWords: input.synonyms ? Object.keys(input.synonyms).length : undefined,
        ...metadata,
      },
    });
  const problem = meiliProblem(rs[0]);
  if (problem) {
    await audit({ status: 'refused', error: problem.message });
    if (problem.kind === 'notFound') throw notFound('search index', `${input.stack}/${input.name}/${input.index}`);
    throw commandRejected(problem.message);
  }
  const enqueued = parseTask(rs[0]?.body);
  const last = rs[1] && !meiliProblem(rs[1]) ? parseTask(rs[1].body) : null;
  const result: SearchSettingsResult = {
    index: input.index,
    taskUid: enqueued.taskUid,
    status: asStatus(last?.status ?? enqueued.status),
    error: last?.error ?? null,
    changed,
  };
  await audit({ taskUid: result.taskUid, status: result.status, error: result.error });
  if (result.status === 'failed') throw commandRejected(result.error ?? 'the engine refused these settings');
  return result;
}
