/**
 * swarm-kv size watch (plans/epic-docker-native-state.md §2b budgets): a
 * document over {@link KV_MAX_DOC_BYTES} or a footprint over
 * {@link KV_MAX_TOTAL_BYTES} is refused at write time, which is too late to
 * be useful. These pure helpers say when a document, or swarmy's whole raft
 * footprint, is approaching its limit, so the controller can log it and
 * Resilience can show it before a save fails. Browser-safe.
 */
import type { KvDocMeta, KvLimits } from './swarm-kv';

/** Warn from this share of a limit… */
export const KV_WARN_RATIO = 0.75;
/** …and call it critical from this one (the next save may be refused). */
export const KV_CRIT_RATIO = 0.95;

export interface KvSizeWarning {
  /** `document`: one document against the per-document limit; `total`: every retained version against the budget. */
  scope: 'document' | 'total';
  collection: string | null;
  id: string | null;
  bytes: number;
  limit: number;
  /** bytes / limit, 0..1+. */
  ratio: number;
  severity: 'warn' | 'crit';
}

/** Bytes held in raft across every retained version. */
export function kvFootprint(docs: readonly KvDocMeta[]): number {
  return docs.reduce((n, d) => n + d.versions.reduce((m, v) => m + v.bytes, 0), 0);
}

/**
 * Documents (latest version) and the whole footprint at or past `warnAt` of
 * their limit, the fullest first.
 */
export function kvSizeWarnings(
  docs: readonly KvDocMeta[],
  limits: Pick<KvLimits, 'maxDocBytes' | 'maxTotalBytes'>,
  warnAt = KV_WARN_RATIO,
): KvSizeWarning[] {
  const out: KvSizeWarning[] = [];
  const push = (scope: KvSizeWarning['scope'], collection: string | null, id: string | null, bytes: number, limit: number) => {
    const ratio = limit > 0 ? bytes / limit : 0;
    if (ratio >= warnAt) out.push({ scope, collection, id, bytes, limit, ratio, severity: ratio >= KV_CRIT_RATIO ? 'crit' : 'warn' });
  };
  for (const d of docs) push('document', d.collection, d.id, d.bytes, limits.maxDocBytes);
  push('total', null, null, kvFootprint(docs), limits.maxTotalBytes);
  return out.sort((a, b) => b.ratio - a.ratio);
}

const kb = (n: number): string => `${(n / 1024).toFixed(1)} KB`;
const pct = (r: number): string => `${Math.round(r * 100)}%`;

/** One log line per warning. */
export function kvSizeLogLine(orgId: string, w: KvSizeWarning): string {
  const what = w.scope === 'document' ? `document ${w.collection}/${w.id}` : 'total footprint (every kept version)';
  return `[swarm-kv] org ${orgId}: ${what} is ${kb(w.bytes)} of its ${kb(w.limit)} limit (${pct(w.ratio)})${
    w.severity === 'crit' ? ' — the next save may be refused' : ''
  }`;
}

/** A stable key for "did the warnings change" (scope, document, and 5% band). */
export function kvSizeKey(warnings: readonly KvSizeWarning[]): string {
  return warnings.map((w) => `${w.scope}:${w.collection ?? ''}/${w.id ?? ''}:${Math.floor(w.ratio * 20)}`).sort().join('|');
}
