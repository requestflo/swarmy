/**
 * Managed search — indexes, their settings, "Try it" and key rotation (board
 * 41). Shared by the controller (router inputs, the views it returns) and the
 * dashboard (forms, the same limits). Pure: no engine access here.
 *
 * Everything is read from, and written to, the engine itself through its HTTP
 * API, called from inside the instance's own container (the master key never
 * leaves its secret file). swarmy stores none of it.
 */
import { z } from 'zod';

/** At most this many indexes are listed for one instance. */
export const MAX_SEARCH_INDEXES = 50;
/** "Try it" shows the top this-many hits. */
export const SEARCH_TRY_HITS = 5;
/** Longest query "Try it" sends. */
export const MAX_SEARCH_QUERY = 200;
/** Searchable / filterable attributes per index (each list). */
export const MAX_SEARCH_ATTRIBUTES = 100;
/** Synonym words with their own list, per index (a write). */
export const MAX_SYNONYM_WORDS = 500;
/** Alternatives one word may have. */
export const MAX_SYNONYM_ALTERNATIVES = 20;
/** Synonym words a read returns (the rest are counted, not listed). */
export const SYNONYM_VIEW_CAP = 200;

const stack = z.string().min(1).max(63).regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'invalid stack name');
const name = z.string().min(1).max(40).regex(/^[A-Za-z0-9][A-Za-z0-9-]*$/, 'invalid instance name');
/** Meilisearch index uids: letters, digits, `-` and `_`. */
export const SearchIndexUid = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/, 'invalid index name');
/** A field name (dots reach nested fields); no control characters. */
const attribute = z.string().min(1).max(100).regex(/^[^\p{Cc}]+$/u, 'invalid attribute name');
const word = z.string().min(1).max(60).regex(/^[^\p{Cc}]+$/u, 'invalid synonym');

export const SearchInstanceRef = z.object({ stack, name });
export type SearchInstanceRef = z.infer<typeof SearchInstanceRef>;

export const SearchIndexRef = SearchInstanceRef.extend({ index: SearchIndexUid });
export type SearchIndexRef = z.infer<typeof SearchIndexRef>;

export const SearchQueryInput = SearchIndexRef.extend({ q: z.string().max(MAX_SEARCH_QUERY) });
export type SearchQueryInput = z.infer<typeof SearchQueryInput>;

/** Only the lists given are written; the rest of the index's settings are left alone. */
export const SetIndexSettingsInput = SearchIndexRef.extend({
  /** Empty = every field (`["*"]`). Order matters: earlier fields rank higher. */
  searchable: z.array(attribute).max(MAX_SEARCH_ATTRIBUTES).optional(),
  filterable: z.array(attribute).max(MAX_SEARCH_ATTRIBUTES).optional(),
  /** Word → the words a search for it also matches (one way, as the engine stores it). */
  synonyms: z
    .record(word, z.array(word).min(1).max(MAX_SYNONYM_ALTERNATIVES))
    .refine((m) => Object.keys(m).length <= MAX_SYNONYM_WORDS, `at most ${MAX_SYNONYM_WORDS} synonym words`)
    .optional(),
});
export type SetIndexSettingsInput = z.infer<typeof SetIndexSettingsInput>;

/** One index as the engine reports it. */
export interface SearchIndexView {
  uid: string;
  primaryKey: string | null;
  docs: number;
  /** Bytes the documents take on disk (`rawDocumentDbSize`, Meilisearch 1.13+), else null. */
  sizeBytes: number | null;
  /** Last change to documents or settings (ISO), when reported. */
  updatedAt: string | null;
  /** The engine is applying a change right now. */
  isIndexing: boolean;
}

export interface SearchIndexListView {
  stack: string;
  name: string;
  /** False on Typesense: index details are read from Meilisearch only. */
  supported: boolean;
  indexes: SearchIndexView[];
  /** Indexes the engine has (may exceed `indexes.length`). */
  total: number;
  truncated: boolean;
  /** Whole database on disk (`databaseSize`), when reported. */
  dbSizeBytes: number | null;
  sampledAt: string;
}

/** One index with the settings swarmy shows and edits. */
export interface SearchIndexSettingsView extends SearchIndexView {
  stack: string;
  name: string;
  /** `["*"]` = every field. */
  searchable: string[];
  filterable: string[];
  sortable: string[];
  /** Word → alternatives (capped at SYNONYM_VIEW_CAP words). */
  synonyms: Record<string, string[]>;
  /** Synonym words the index has in all. */
  synonymWords: number;
  synonymsTruncated: boolean;
}

/** One "Try it" hit, cut down to what a person reads. */
export interface SearchHitView {
  /** The document's primary key value, when it has one. */
  id: string | null;
  /** The most title-like field (`title`, `name`, … else the first text field). */
  title: string;
  /** A few other short fields, `key: value · key: value`. */
  meta: string;
  /** `_rankingScore` (0–1), when the engine returned it. */
  score: number | null;
}

export interface SearchQueryView {
  index: string;
  q: string;
  hits: SearchHitView[];
  /** The engine's estimate of all matches, when given. */
  estimatedTotal: number | null;
  processingTimeMs: number;
}

/** A settings write is a task the engine runs; swarmy waits a few seconds for it. */
export interface SearchSettingsResult {
  index: string;
  taskUid: number | null;
  status: 'succeeded' | 'failed' | 'processing' | 'enqueued' | 'canceled';
  /** The engine's own message when the task failed. */
  error: string | null;
  changed: Array<'searchable' | 'filterable' | 'synonyms'>;
}

/** Returned ONCE by search.rotateKey — the new key is not retrievable later. */
export interface SearchKeyRotateResult {
  stack: string;
  name: string;
  /** The new Docker secret version (`…-key__v<n>`). */
  keySecret: string;
  version: number;
  masterKey: string;
  /** The engine first, then every attached app (each restarted). */
  redeployed: string[];
}
