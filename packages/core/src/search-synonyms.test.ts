import { describe, expect, it } from 'bun:test';
import { formatSynonyms, parseSynonyms, synonymLines } from './search-synonyms';
import { SetIndexSettingsInput } from './search-indexes';

const MAP = {
  cup: ['mug'],
  mug: ['cup'],
  't-shirt': ['tee'],
  tee: ['t-shirt'],
  phone: ['smartphone'],
};

describe('synonyms — sets for people, a one-way map for Meilisearch', () => {
  it('folds mutual entries into sets and keeps one-way entries as arrows', () => {
    expect(synonymLines(MAP)).toEqual([
      { kind: 'set', words: ['cup', 'mug'] },
      { kind: 'oneWay', words: ['phone', 'smartphone'] },
      { kind: 'set', words: ['t-shirt', 'tee'] },
    ]);
    expect(formatSynonyms(MAP)).toBe('cup = mug\nphone -> smartphone\nt-shirt = tee');
  });

  it('a round trip leaves the engine map unchanged', () => {
    const parsed = parseSynonyms(formatSynonyms(MAP));
    expect(parsed).toEqual({ ok: true, map: MAP });
  });

  it('a three-word set maps every word to the other two', () => {
    expect(parseSynonyms('mug = cup, beaker')).toEqual({
      ok: true,
      map: { mug: ['cup', 'beaker'], cup: ['mug', 'beaker'], beaker: ['mug', 'cup'] },
    });
  });

  it('a half-mutual map is never shown as a set', () => {
    const map = { a: ['b'], b: ['a', 'c'] };
    expect(formatSynonyms(map)).toBe('a -> b\nb -> a, c');
    expect(parseSynonyms(formatSynonyms(map))).toEqual({ ok: true, map });
  });

  it('skips blanks and comments, and says which line is wrong', () => {
    expect(parseSynonyms('# sizes\n\nxl = extra large')).toEqual({
      ok: true,
      map: { xl: ['extra large'], 'extra large': ['xl'] },
    });
    expect(parseSynonyms('mug = cup\njust words')).toMatchObject({ ok: false, line: 2 });
    expect(parseSynonyms('mug =')).toMatchObject({ ok: false, line: 1 });
    expect(parseSynonyms('a, b -> c')).toMatchObject({ ok: false, line: 1 });
  });

  it('the settings input bounds what a write may carry', () => {
    const base = { stack: 'shop', name: 'main', index: 'products' };
    expect(SetIndexSettingsInput.safeParse({ ...base, searchable: ['title', 'brand.name'] }).success).toBe(true);
    expect(SetIndexSettingsInput.safeParse({ ...base, index: 'bad/name' }).success).toBe(false);
    expect(SetIndexSettingsInput.safeParse({ ...base, synonyms: { mug: [] } }).success).toBe(false);
    expect(SetIndexSettingsInput.safeParse({ ...base, filterable: ['a\nb'] }).success).toBe(false);
  });
});
