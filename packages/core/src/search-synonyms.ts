/**
 * Synonyms as people write them, and as Meilisearch stores them. Pure; shared
 * by the dashboard editor and its summary line.
 *
 * Meilisearch keeps a one-way map (`{ mug: ['cup'] }` makes "mug" also match
 * "cup", not the reverse). People think in sets. So a line is either
 *   `mug = cup, beaker`   a set: every word matches every other, or
 *   `phone -> smartphone` one way: the left word also matches the right ones.
 * `formatSynonyms` folds a map back into sets wherever it is mutual, so a
 * round trip leaves the engine's map unchanged.
 */
import { MAX_SYNONYM_ALTERNATIVES, MAX_SYNONYM_WORDS } from './search-indexes';

export type SynonymMap = Record<string, string[]>;

export interface SynonymLine {
  kind: 'set' | 'oneWay';
  words: string[];
}

const sameSet = (a: string[], b: string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Group a map into sets (where every member maps to all the others) and one-way lines. */
export function synonymLines(map: SynonymMap): SynonymLine[] {
  const out: SynonymLine[] = [];
  const used = new Set<string>();
  for (const key of Object.keys(map).sort()) {
    if (used.has(key)) continue;
    const alts = [...new Set(map[key] ?? [])].filter((w) => w !== key);
    const members = [key, ...alts];
    const mutual =
      alts.length > 0 &&
      alts.every((w) => !used.has(w) && map[w] !== undefined && sameSet(map[w]!.filter((x) => x !== w), members.filter((x) => x !== w)));
    if (mutual) {
      members.forEach((w) => used.add(w));
      out.push({ kind: 'set', words: [...members].sort() });
    } else {
      used.add(key);
      out.push({ kind: 'oneWay', words: [key, ...alts] });
    }
  }
  return out;
}

/** One line of text: `a = b, c` or `a -> b, c`. */
export function formatSynonymLine(l: SynonymLine): string {
  const [first, ...rest] = l.words;
  return `${first} ${l.kind === 'set' ? '=' : '->'} ${rest.join(', ')}`;
}

/** The editor's text for a map. */
export function formatSynonyms(map: SynonymMap): string {
  return synonymLines(map).map(formatSynonymLine).join('\n');
}

export type SynonymParse = { ok: true; map: SynonymMap } | { ok: false; line: number; reason: string };

const split = (s: string): string[] =>
  s.split(',').map((w) => w.trim()).filter(Boolean);

/** Parse the editor's text. Blank lines and `#` comments are skipped. */
export function parseSynonyms(text: string): SynonymParse {
  const acc = new Map<string, Set<string>>();
  const add = (k: string, ws: string[]): void => {
    const s = acc.get(k) ?? new Set<string>();
    ws.filter((w) => w !== k).forEach((w) => s.add(w));
    acc.set(k, s);
  };
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (!raw || raw.startsWith('#')) continue;
    const oneWay = raw.indexOf('->');
    const eq = raw.indexOf('=');
    if (oneWay < 0 && eq < 0) return { ok: false, line: i + 1, reason: 'write `a = b, c` or `a -> b`' };
    if (oneWay >= 0) {
      const left = split(raw.slice(0, oneWay));
      const right = split(raw.slice(oneWay + 2));
      if (left.length !== 1 || right.length === 0) return { ok: false, line: i + 1, reason: 'one word before `->`, at least one after' };
      add(left[0]!, right);
    } else {
      const words = [...new Set([...split(raw.slice(0, eq)), ...split(raw.slice(eq + 1))])];
      if (words.length < 2) return { ok: false, line: i + 1, reason: 'a set needs two words or more' };
      words.forEach((w) => add(w, words));
    }
  }
  const map: SynonymMap = {};
  for (const [k, v] of acc) {
    if (v.size === 0) continue;
    if (v.size > MAX_SYNONYM_ALTERNATIVES) return { ok: false, line: 0, reason: `"${k}" has more than ${MAX_SYNONYM_ALTERNATIVES} alternatives` };
    map[k] = [...v];
  }
  if (Object.keys(map).length > MAX_SYNONYM_WORDS) return { ok: false, line: 0, reason: `more than ${MAX_SYNONYM_WORDS} words` };
  return { ok: true, map };
}
