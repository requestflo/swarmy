import { synonymLines, formatSynonymLine, type SearchIndexView, type SearchQueryView } from '@swarmy/core';
import { relativeTime } from '@/components/resilience/format';
import { bytes } from '@/lib/format';

/** `41,208 docs · 312 MB · updated 4m ago` (size only when the engine reports it). */
export function indexLine(ix: SearchIndexView): string {
  const parts = [`${ix.docs.toLocaleString()} ${ix.docs === 1 ? 'doc' : 'docs'}`];
  if (ix.sizeBytes !== null) parts.push(bytes(ix.sizeBytes));
  if (ix.isIndexing) parts.push('indexing now');
  else if (ix.updatedAt) parts.push(`updated ${relativeTime(ix.updatedAt)}`);
  return parts.join(' · ');
}

/** Searchable fields in plain words: `["*"]` is every field. */
export function fieldsWords(fields: string[]): string[] {
  return fields.length === 1 && fields[0] === '*' ? [] : fields;
}

/** `18 sets · mug = cup, tee = t-shirt` — the first few lines, then the count. */
export function synonymsLine(map: Record<string, string[]>, words: number, show = 2): string {
  const lines = synonymLines(map);
  if (lines.length === 0) return words > 0 ? `${words} words` : 'none yet';
  const head = lines.slice(0, show).map(formatSynonymLine).join(', ');
  const truncated = words > Object.keys(map).length;
  const count = `${lines.length}${truncated ? '+' : ''} ${lines.length === 1 ? 'set' : 'sets'}`;
  return `${count} · ${head}${lines.length > show ? ', …' : ''}`;
}

/** `5 of about 1,204 · 3 ms` under the Try it results. */
export function queryMeta(r: SearchQueryView): string {
  const total = r.estimatedTotal !== null ? ` of about ${r.estimatedTotal.toLocaleString()}` : '';
  if (r.hits.length === 0) return `Nothing matches “${r.q}” · ${r.processingTimeMs} ms`;
  return `${r.hits.length}${total} · ${r.processingTimeMs} ms`;
}

/** A score as people read it: `0.97`. */
export function scoreWord(score: number | null): string {
  return score === null ? '' : score.toFixed(2);
}

/** Comma-separated text → a clean field list (trimmed, no blanks, no repeats). */
export function parseFields(text: string): string[] {
  return [...new Set(text.split(',').map((f) => f.trim()).filter(Boolean))];
}
