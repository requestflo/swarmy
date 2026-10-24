/**
 * Managed search indexes (board 41): list them, read one's settings, "Try
 * it", and edit searchable / filterable / synonyms — straight against the
 * engine's HTTP API, from inside the instance's own container (agent `exec`,
 * the way the queue studio runs inside the cache primary). Managed search is
 * private-only, so nothing here opens a network path, and the master key
 * stays in its secret file. Reads are capped (indexes, synonyms, hits, cut
 * strings) and every call is audited. swarmy keeps none of it: the engine is
 * the truth.
 */
import { randomBytes } from 'node:crypto';
import {
  MAX_SEARCH_INDEXES,
  SEARCH_TRY_HITS,
  type SearchIndexListView,
  type SearchIndexRef,
  type SearchIndexSettingsView,
  type SearchQueryInput,
  type SearchQueryView,
} from '@swarmy/core';
import type { OrgContext } from '../context';
import { commandRejected, mapDispatchError, notFound } from '../errors';
import { writeAudit } from './audit.service';
import { resolveExecTarget } from './live-resolve';
import { searchBaseName, requireInstance, searchEngineOf, type LiveInstance } from './search.service';
import { indexPath, meiliProblem, meiliScript, splitResponses, type MeiliRequest, type MeiliResponse } from './search-indexes.core';
import { indexView, parseIndexList, parseQuery, parseSettings } from './search-indexes.parse';
import { readGate } from './search-gate';

const EXEC_TIMEOUT_MS = 20_000;

export const newMarker = (): string => `@@${randomBytes(8).toString('hex')}`;

/** The Meilisearch instance to talk to (Typesense is refused here). */
export function meiliInstance(ctx: OrgContext, ref: { stack: string; name: string }): LiveInstance {
  const i = requireInstance(ctx, ref.stack, ref.name);
  if (searchEngineOf(i.service.labels) !== 'meilisearch') {
    throw commandRejected('index details are read from Meilisearch only — this instance runs Typesense');
  }
  return i;
}

/** Exec one script in the engine container; `$1` carries `arg` (never spliced in). */
export async function runInEngine(ctx: OrgContext, i: LiveInstance, script: string, marker: string, arg = ''): Promise<MeiliResponse[]> {
  const target = resolveExecTarget(ctx, i.service.name);
  if (!target) throw commandRejected(`search ${i.stack}/${i.name} has no running container`);
  let res: { exitCode: number; output?: string };
  try {
    res = await ctx.hub.dispatch<{ exitCode: number; output?: string }>(
      target.nodeId,
      'exec',
      { target: { containerId: target.containerId }, cmd: ['sh', '-c', script, 'swarmy-search', arg], tty: false, stream: false },
      { timeoutMs: EXEC_TIMEOUT_MS },
    );
  } catch (e) {
    throw mapDispatchError(e);
  }
  const out = splitResponses(res.output ?? '', marker);
  if (res.exitCode !== 0 && out.length === 0) {
    throw commandRejected(`the search engine did not answer: ${(res.output ?? '').trim().slice(0, 200) || `exit ${res.exitCode}`}`);
  }
  return out;
}

/** Throw the first failed response as a tRPC error. */
export function assertOk(rs: MeiliResponse[], count: number, what: string): void {
  for (let n = 0; n < count; n++) {
    const p = meiliProblem(rs[n]);
    if (!p) continue;
    if (p.kind === 'notFound') throw notFound('search index', what);
    throw commandRejected(p.message);
  }
}

async function call(ctx: OrgContext, i: LiveInstance, reqs: MeiliRequest[], what: string, arg?: string): Promise<MeiliResponse[]> {
  const marker = newMarker();
  const rs = await runInEngine(ctx, i, meiliScript(reqs, marker), marker, arg);
  assertOk(rs, reqs.length, what);
  return rs;
}

const auditId = (ref: { stack: string; name: string }): string => searchBaseName(ref.stack, ref.name);

/** Every index on the instance: documents, size, last change. Typesense ⇒ `supported: false`. */
export async function searchIndexes(ctx: OrgContext, ref: { stack: string; name: string }): Promise<SearchIndexListView> {
  const base = { stack: ref.stack, name: ref.name, sampledAt: new Date().toISOString() };
  const i = requireInstance(ctx, ref.stack, ref.name);
  if (searchEngineOf(i.service.labels) !== 'meilisearch') {
    return { ...base, supported: false, indexes: [], total: 0, truncated: false, dbSizeBytes: null };
  }
  const rs = await call(ctx, i, [{ method: 'GET', path: `/indexes?limit=${MAX_SEARCH_INDEXES}` }, { method: 'GET', path: '/stats' }], auditId(ref));
  const list = parseIndexList(rs[0]?.body, rs[1]?.body);
  if (!list) throw commandRejected('the search engine sent an index list swarmy could not read');
  await writeAudit(ctx, { action: 'search.indexes.read', targetType: 'searchInstance', targetId: auditId(ref), metadata: { count: list.total } });
  return { ...base, supported: true, ...list, truncated: list.total > list.indexes.length };
}

/** One index with its searchable / filterable / sortable fields and synonyms. */
export async function searchIndex(ctx: OrgContext, ref: SearchIndexRef): Promise<SearchIndexSettingsView> {
  const i = meiliInstance(ctx, ref);
  const rs = await call(
    ctx,
    i,
    [
      { method: 'GET', path: indexPath(ref.index) },
      { method: 'GET', path: indexPath(ref.index, '/stats') },
      { method: 'GET', path: indexPath(ref.index, '/settings') },
    ],
    `${ref.stack}/${ref.name}/${ref.index}`,
  );
  await writeAudit(ctx, { action: 'search.index.read', targetType: 'searchInstance', targetId: auditId(ref), metadata: { index: ref.index } });
  return { stack: ref.stack, name: ref.name, ...indexView(rs[0]?.body, rs[1]?.body), ...parseSettings(rs[2]?.body) };
}

/** "Try it": the top hits for `q` and how long the engine took. Gated `data.read` (documents are data). */
export async function searchQuery(ctx: OrgContext, input: SearchQueryInput): Promise<SearchQueryView> {
  const i = meiliInstance(ctx, input);
  const policyId = await readGate(ctx, input.stack);
  const body = JSON.stringify({ q: input.q, limit: SEARCH_TRY_HITS, showRankingScore: true });
  const rs = await call(
    ctx,
    i,
    [{ method: 'GET', path: indexPath(input.index) }, { method: 'POST', path: indexPath(input.index, '/search'), body: true }],
    `${input.stack}/${input.name}/${input.index}`,
    body,
  );
  const primaryKey = (rs[0]?.body as { primaryKey?: unknown } | null)?.primaryKey;
  const parsed = parseQuery(rs[1]?.body, typeof primaryKey === 'string' ? primaryKey : null, SEARCH_TRY_HITS);
  if (!parsed) throw commandRejected('the search engine sent results swarmy could not read (too large?)');
  await writeAudit(ctx, {
    action: 'search.query',
    targetType: 'searchInstance',
    targetId: auditId(input),
    metadata: { index: input.index, q: input.q.slice(0, 80), hits: parsed.hits.length, ms: parsed.processingTimeMs, policyId },
  });
  return { index: input.index, q: input.q, ...parsed };
}
