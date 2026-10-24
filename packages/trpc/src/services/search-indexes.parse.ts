/**
 * PURE — Meilisearch JSON → the views swarmy returns. Every list is capped and
 * every string cut, so a huge index or document can't balloon a response.
 */
import {
  MAX_SEARCH_INDEXES,
  SYNONYM_VIEW_CAP,
  type SearchHitView,
  type SearchIndexView,
} from '@swarmy/core';

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Attribute lists; Meilisearch 1.14+ may give `{ attributePatterns }` objects among the strings. */
export function attributeList(v: unknown, cap = 100): string[] {
  if (!Array.isArray(v)) return [];
  const out = v.flatMap((x) => {
    if (typeof x === 'string') return [x];
    const p = obj(x).attributePatterns;
    return Array.isArray(p) ? p.filter((s): s is string => typeof s === 'string') : [];
  });
  return out.slice(0, cap);
}

/** One index from `GET /indexes` (`results[]`) joined with its `/stats` entry. */
export function indexView(row: unknown, stats: unknown): SearchIndexView {
  const r = obj(row);
  const s = obj(stats);
  return {
    uid: String(r.uid ?? ''),
    primaryKey: str(r.primaryKey),
    docs: num(s.numberOfDocuments) ?? 0,
    sizeBytes: num(s.rawDocumentDbSize),
    updatedAt: str(r.updatedAt),
    isIndexing: s.isIndexing === true,
  };
}

/** `GET /indexes?limit=…` + `GET /stats` → the list (newest change first). */
export function parseIndexList(
  indexes: unknown,
  stats: unknown,
): { indexes: SearchIndexView[]; total: number; dbSizeBytes: number | null } | null {
  const list = obj(indexes).results;
  if (!Array.isArray(list)) return null;
  const perIndex = obj(obj(stats).indexes);
  const views = list
    .slice(0, MAX_SEARCH_INDEXES)
    .map((row) => indexView(row, perIndex[String(obj(row).uid ?? '')]))
    .filter((v) => v.uid)
    .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '') || a.uid.localeCompare(b.uid));
  return {
    indexes: views,
    total: num(obj(indexes).total) ?? views.length,
    dbSizeBytes: num(obj(stats).databaseSize),
  };
}

/** `GET /indexes/{uid}/settings` → the lists swarmy shows (synonyms capped). */
export function parseSettings(settings: unknown): {
  searchable: string[];
  filterable: string[];
  sortable: string[];
  synonyms: Record<string, string[]>;
  synonymWords: number;
  synonymsTruncated: boolean;
} {
  const s = obj(settings);
  const all = Object.entries(obj(s.synonyms)).filter(([, v]) => Array.isArray(v));
  const synonyms: Record<string, string[]> = {};
  for (const [k, v] of all.slice(0, SYNONYM_VIEW_CAP)) {
    synonyms[k] = (v as unknown[]).filter((w): w is string => typeof w === 'string').slice(0, 50);
  }
  const searchable = attributeList(s.searchableAttributes);
  return {
    searchable: searchable.length ? searchable : ['*'],
    filterable: attributeList(s.filterableAttributes),
    sortable: attributeList(s.sortableAttributes),
    synonyms,
    synonymWords: all.length,
    synonymsTruncated: all.length > SYNONYM_VIEW_CAP,
  };
}

const TITLE_KEYS = ['title', 'name', 'label', 'headline', 'subject', 'heading'];

const scalar = (v: unknown): string | null =>
  typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;

/** One hit cut to a title, a meta line and its score. Fields starting with `_` are the engine's. */
export function hitView(hit: unknown, primaryKey: string | null): SearchHitView {
  const h = obj(hit);
  const idKey = primaryKey && h[primaryKey] !== undefined ? primaryKey : h.id !== undefined ? 'id' : null;
  const id = idKey ? scalar(h[idKey]) : null;
  const fields = Object.entries(h).filter(([k]) => !k.startsWith('_') && k !== idKey);
  const titleKey =
    TITLE_KEYS.find((k) => typeof h[k] === 'string' && h[k]) ??
    fields.find(([, v]) => typeof v === 'string' && v)?.[0] ??
    null;
  const meta = fields
    .filter(([k]) => k !== titleKey)
    .flatMap(([k, v]) => {
      const s = scalar(v);
      return s !== null && s !== '' ? [`${k}: ${cut(s, 40)}`] : [];
    })
    .slice(0, 3)
    .join(' · ');
  return {
    id: id !== null ? cut(id, 80) : null,
    title: cut(titleKey ? String(h[titleKey]) : (id ?? '(no text fields)'), 120),
    meta: cut(meta, 160),
    score: num(h._rankingScore),
  };
}

/** `POST /indexes/{uid}/search` → hits (top N) + timing. */
export function parseQuery(body: unknown, primaryKey: string | null, limit: number) {
  const b = obj(body);
  const hits = Array.isArray(b.hits) ? b.hits.slice(0, limit).map((h) => hitView(h, primaryKey)) : null;
  if (!hits) return null;
  return {
    hits,
    estimatedTotal: num(b.estimatedTotalHits) ?? num(b.totalHits),
    processingTimeMs: num(b.processingTimeMs) ?? 0,
  };
}

/** A task (`/tasks/{uid}` or the enqueue reply) → its status and error message. */
export function parseTask(body: unknown): { taskUid: number | null; status: string | null; error: string | null } {
  const b = obj(body);
  return {
    taskUid: num(b.taskUid) ?? num(b.uid),
    status: str(b.status),
    error: str(obj(b.error).message),
  };
}
