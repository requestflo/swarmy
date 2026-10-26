/**
 * What switching search engines would take (board 41: "Meilisearch · switch
 * to Typesense makes a new index"). PURE — unit-tested.
 *
 * swarmy doesn't offer the switch: it is a data migration (every document
 * exported and imported, settings mapped where they map at all) AND a change
 * to the app's own search code, which swarmy can't make. So the page says
 * what it would take, and the way to move that keeps search up.
 */
export type SearchEngine = 'meilisearch' | 'typesense';

const NAME: Record<SearchEngine, string> = { meilisearch: 'Meilisearch', typesense: 'Typesense' };
const HOST: Record<SearchEngine, string> = { meilisearch: 'MEILI_HOST', typesense: 'TYPESENSE_HOST' };

export interface SwitchStep {
  head: string;
  body: string;
}

export function engineSwitch(from: SearchEngine, app: string | null): { to: string; steps: SwitchStep[]; move: string } {
  const to: SearchEngine = from === 'meilisearch' ? 'typesense' : 'meilisearch';
  const who = app ?? 'your app';
  const settings =
    from === 'meilisearch'
      ? 'Filters and sortable fields become typed fields in the collection’s schema, and synonyms carry over. Searchable fields don’t: Typesense takes them on every search (query_by), from your app. Ranking rules and typo settings have no one-to-one match.'
      : 'Facet and sort fields become filterable and sortable attributes, the query_by your app sends becomes the searchable list, and synonyms carry over. Per-search options (prefix, typo tokens) stay with your app’s calls.';
  const copy =
    from === 'meilisearch'
      ? 'Typesense keeps a schema of typed fields and Meilisearch doesn’t, so each field’s type has to be decided (or left to Typesense’s auto-detection) before the copy.'
      : 'Meilisearch infers fields itself; document ids must be letters, digits, - and _ only, so some ids may need rewriting.';
  return {
    to: NAME[to],
    steps: [
      { head: `A new ${NAME[to]} instance`, body: 'An engine is fixed when an instance is made, so a switch makes a new index next to this one; it never converts it.' },
      { head: 'Every document copied across', body: copy },
      { head: 'Settings mapped, where they map', body: settings },
      {
        head: `${who}’s search code`,
        body: `${NAME[from]} and ${NAME[to]} have different APIs and clients, so ${who} moves from ${HOST[from]} to ${HOST[to]} and its search calls change. swarmy can’t make that change.`,
      },
    ],
    move: `So swarmy doesn’t switch engines for you. To move without search going down: make a ${NAME[to]} instance here, attach it to ${who}, have ${who} index into both, move its searches over, then remove this one.`,
  };
}
