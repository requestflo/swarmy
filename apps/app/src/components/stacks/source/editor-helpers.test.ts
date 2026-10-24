import { describe, expect, it } from 'bun:test';
import { parseAppConfig } from '@swarmy/app-config';
import { lineStarts, lineText, newlineFor, offsetToPos, posToOffset } from './editor-lines';
import { cursorContext } from './yaml-context';
import { completionsFor } from './schema-complete';
import { fixFor, nearest } from './fixes';
import { changedLines, highlightLine } from './yaml-highlight';

/** Text with a `|` marking the cursor → [text, offset]. */
const at = (marked: string): [string, number] => [marked.replace('|', ''), marked.indexOf('|')];
const complete = (marked: string) => completionsFor(cursorContext(...at(marked)));

describe('line mapping', () => {
  const text = 'version: 1\napp: shop\n\nservices:\n';
  const starts = lineStarts(text);
  it('maps offsets to the parser’s 1-based line and column', () => {
    expect(starts).toEqual([0, 11, 21, 22, 32]);
    expect(offsetToPos(starts, 0)).toEqual({ line: 1, col: 1 });
    expect(offsetToPos(starts, 16)).toEqual({ line: 2, col: 6 });
    expect(offsetToPos(starts, 21)).toEqual({ line: 3, col: 1 });
  });
  it('maps lines back to offsets and reads a line', () => {
    expect(posToOffset(starts, 2, 6)).toBe(16);
    expect(posToOffset(starts, 99)).toBe(32);
    expect(lineText(text, starts, 4)).toBe('services:');
  });
  it('indents the next line, one step deeper after a block key', () => {
    expect(newlineFor('resources:')).toBe('\n  ');
    expect(newlineFor('    port: 3000')).toBe('\n    ');
    expect(newlineFor('  # a note:')).toBe('\n  ');
  });
});

describe('highlighting and the saved-file diff', () => {
  it('colours keys, numbers, bindings and comments without changing a character', () => {
    const line = '      DATABASE_URL: ${{ db.url }} # primary';
    const tokens = highlightLine(line);
    expect(tokens.map((t) => t.text).join('')).toBe(line);
    expect(tokens.filter((t) => t.cls !== 'plain').map((t) => [t.cls, t.text.trim()])).toEqual([
      ['key', 'DATABASE_URL'],
      ['binding', '${{ db.url }}'],
      ['comment', '# primary'],
    ]);
    expect(highlightLine('    port: 3000').find((t) => t.cls === 'number')?.text).toBe('3000');
  });
  it('marks the lines an edit added or changed', () => {
    expect([...changedLines('a\nb\nc', 'a\nb2\nc\nd')]).toEqual([2, 4]);
    expect(changedLines('a\nb', 'a\nb').size).toBe(0);
  });
});

describe('cursor context', () => {
  it('finds the enclosing mappings by indentation', () => {
    const ctx = cursorContext(...at('services:\n  web:\n    image: x\n    rep|\n'));
    expect(ctx).toMatchObject({ kind: 'key', path: ['services', 'web'], prefix: 'rep', indent: 4 });
    expect(ctx.siblings).toEqual({ image: 'x' });
  });
  it('knows a value is being typed, and skips lists and flow values', () => {
    expect(cursorContext(...at('resources:\n  db:\n    type: po|'))).toMatchObject({ kind: 'value', path: ['resources', 'db'], key: 'type', prefix: 'po' });
    expect(cursorContext(...at('services:\n  web:\n    domains:\n      - ho|')).kind).toBe('none');
    expect(cursorContext(...at('services:\n  web: { image: x }\n    po|')).kind).toBe('none');
  });
});

describe('schema autocomplete', () => {
  it('offers a service’s keys that are not there yet', () => {
    const list = complete('version: 1\nservices:\n  web:\n    image: x\n    re|');
    expect(list?.title).toBe('services.<name>');
    expect(list?.items.map((i) => i.label)).toEqual(['release', 'replicas', 'regions']);
    expect(list?.items[1]?.insert).toBe('replicas: ');
  });
  it('opens a block for a mapping key', () => {
    expect(complete('services:\n  web:\n    health|')?.items[0]?.insert).toBe('healthcheck:\n      ');
  });
  it('offers one starter per resource type at a new resource name, named to avoid what is there', () => {
    const list = complete('resources:\n  db: postgres\n  |');
    expect(list?.title).toBe('resources.<name>.type');
    expect(list?.items.map((i) => i.label)).toEqual(['postgres', 'cache', 'queue', 'search', 'vector', 'bucket']);
    expect(list?.items[0]?.insert).toBe('db-2:\n    type: postgres\n    version: 16\n    ha: single');
  });
  it('narrows a resource’s keys by its type and lists allowed values', () => {
    expect(complete('resources:\n  c:\n    type: cache\n    |')?.items.map((i) => i.label)).toEqual(['engine', 'ha', 'replicas', 'memory']);
    expect(complete('resources:\n  db:\n    type: |')?.items.map((i) => i.label)).toEqual(['postgres', 'cache', 'queue', 'search', 'vector', 'bucket']);
    expect(complete('services:\n  web:\n    size: s|')?.items.map((i) => i.label)).toEqual(['small']);
  });
  it('stays quiet where the schema has nothing to offer', () => {
    expect(complete('services:\n  web:\n    env:\n      DATABASE_|')).toBeNull();
    expect(complete('services:\n  |')).toBeNull();
  });
});

describe('fixes', () => {
  const issueOf = (text: string) => parseAppConfig(text).issues.find((i) => i.severity === 'error');
  const base = 'version: 1\napp: shop\nservices:\n  web:\n    image: nginx:1.27\n';

  it('renames an unknown key to the schema key it was reaching for', () => {
    const text = `${base}    replica: 2\n`;
    const fix = fixFor(issueOf(text)!, text);
    expect(fix).toMatchObject({ to: 'replicas', line: 6 });
    expect(parseAppConfig(fix!.apply(text)).config).toBeDefined();
  });
  it('picks the listed option for a near-miss value', () => {
    const text = `${base}    size: smal\n`;
    expect(fixFor(issueOf(text)!, text)?.apply(text)).toContain('size: small');
    const typed = `${base}resources:\n  db:\n    type: postgress\n`;
    expect(fixFor(issueOf(typed)!, typed)?.to).toBe('postgres');
  });
  it('fixes a binding field the parser lists the fields for', () => {
    const text = `${base}    env:\n      DATABASE_URL: \${{ db.uri }}\nresources:\n  db: postgres\n`;
    const fix = fixFor(issueOf(text)!, text);
    expect(fix?.to).toBe('url');
    expect(fix?.apply(text)).toContain('DATABASE_URL: ${{ db.url }}');
  });
  it('never guesses when nothing is close', () => {
    const text = `${base}    flavour: 2\n`;
    expect(fixFor(issueOf(text)!, text)).toBeNull();
    expect(nearest('zzz', ['postgres', 'cache'])).toBeNull();
  });
});
