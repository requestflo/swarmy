import type { SearchHitView } from '@swarmy/core';
import type { DemoIndex } from './searchsvc-indexes-seed';

/**
 * A tiny stand-in for Meilisearch's ranking over the demo index's sample
 * documents: each query word (and its synonyms) found in a searchable field
 * scores, earlier fields score higher. Good enough to make "Try it" feel real;
 * the counts are scaled to the index's full document count.
 */
function fieldsOf(ix: DemoIndex, doc: Record<string, unknown>): string[] {
  return ix.searchable[0] === '*' ? Object.keys(doc) : ix.searchable;
}

export function demoQuery(ix: DemoIndex, q: string): { hits: SearchHitView[]; estimatedTotal: number; processingTimeMs: number } {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const expand = (w: string): string[] => [w, ...(ix.synonyms[w] ?? [])];
  const scored = ix.sample
    .map((doc) => {
      const fields = fieldsOf(ix, doc);
      let score = words.length === 0 ? 0.5 : 0;
      for (const w of words) {
        const has = (f: string, xs: string[]): boolean => xs.some((x) => String(doc[f] ?? '').toLowerCase().includes(x));
        const direct = fields.findIndex((f) => has(f, [w]));
        const viaSynonym = fields.findIndex((f) => has(f, expand(w)));
        if (direct >= 0) score += (1 - direct * 0.12) / words.length;
        else if (viaSynonym >= 0) score += (0.85 - viaSynonym * 0.12) / words.length;
      }
      return { doc, score: Math.min(1, Math.round(score * 100) / 100) };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  const titleKey = ['title', 'name'].find((k) => k in (ix.sample[0] ?? {})) ?? ix.primaryKey;
  const hits = scored.slice(0, 5).map(({ doc, score }) => ({
    id: String(doc[ix.primaryKey] ?? ''),
    title: String(doc[titleKey] ?? doc[ix.primaryKey] ?? ''),
    meta: Object.entries(doc)
      .filter(([k]) => k !== titleKey && k !== ix.primaryKey && k !== 'description' && k !== 'body')
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${String(v)}`)
      .join(' · '),
    score,
  }));
  const share = ix.sample.length ? scored.length / ix.sample.length : 0;
  return {
    hits,
    estimatedTotal: Math.round(share * ix.docs),
    processingTimeMs: 1 + Math.floor(Math.random() * 4),
  };
}
