import { indentOf } from './editor-lines';

/**
 * Where the cursor is in a block-style swarmy.yaml (pure, tolerant of a
 * half-typed file): typing a key, or typing a key's value, inside which
 * mapping. Indentation decides the parents, the way YAML does. Flow
 * mappings (`{ … }`), list items and comments get no completion.
 */
export interface CursorContext {
  kind: 'key' | 'value' | 'none';
  /** Keys of the enclosing mappings, outermost first (`['resources', 'db']`). */
  path: string[];
  /** For a value: the key it belongs to. */
  key?: string;
  /** The partial word before the cursor. */
  prefix: string;
  /** Offset where the partial word starts (a completion replaces from here). */
  from: number;
  /** Indent of the cursor's line. */
  indent: number;
  /** Keys already in this mapping → their inline value ('' for a block). */
  siblings: Record<string, string>;
}

const NONE: CursorContext = { kind: 'none', path: [], prefix: '', from: 0, indent: 0, siblings: {} };
const KEY_LINE = /^(\s*)([A-Za-z0-9_.-]+):(?:\s+(.*?))?\s*$/;
const isContent = (l: string): boolean => l.trim() !== '' && !/^\s*#/.test(l);
const stripComment = (v: string): string => v.replace(/(^|\s+)#.*$/, '').trim();

/** The mappings that enclose line `li` at `indent`, or null inside a list or a flow value. */
function parentsOf(lines: string[], li: number, indent: number): string[] | null {
  const path: string[] = [];
  let cur = indent;
  for (let i = li - 1; i >= 0 && cur > 0; i--) {
    const l = lines[i] ?? '';
    if (!isContent(l)) continue;
    const ind = indentOf(l);
    if (ind >= cur) continue;
    const m = KEY_LINE.exec(l);
    if (!m || (m[3] && stripComment(m[3]) !== '') || /^\s*- /.test(l)) return null;
    path.unshift(m[2] ?? '');
    cur = ind;
  }
  return path;
}

/** Keys at exactly `indent` in the block around line `li` (the cursor's line excluded). */
function siblingsOf(lines: string[], li: number, indent: number): Record<string, string> {
  const out: Record<string, string> = {};
  const scan = (from: number, step: 1 | -1): void => {
    for (let i = from; i >= 0 && i < lines.length; i += step) {
      const l = lines[i] ?? '';
      if (!isContent(l)) continue;
      const ind = indentOf(l);
      if (ind < indent) return;
      const m = ind === indent ? KEY_LINE.exec(l) : null;
      if (m?.[2]) out[m[2]] = stripComment(m[3] ?? '');
    }
  };
  scan(li - 1, -1);
  scan(li + 1, 1);
  return out;
}

export function cursorContext(text: string, offset: number): CursorContext {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
  const lineEndAt = text.indexOf('\n', offset);
  const line = text.slice(lineStart, lineEndAt === -1 ? undefined : lineEndAt);
  const before = line.slice(0, offset - lineStart);
  const after = line.slice(offset - lineStart);
  if (/^\s*(#|- )/.test(line) || /^\s*-$/.test(before.trimEnd()) || before.includes('\t')) return NONE;

  const lines = text.split('\n');
  const li = text.slice(0, lineStart).split('\n').length - 1;
  const keyTyping = /^(\s*)([A-Za-z0-9_.-]*)$/.exec(before);
  if (keyTyping && /^[A-Za-z0-9_-]*\s*$/.test(after)) {
    const indent = keyTyping[1]?.length ?? 0;
    const path = parentsOf(lines, li, indent);
    if (!path) return NONE;
    const prefix = keyTyping[2] ?? '';
    return { kind: 'key', path, prefix, from: offset - prefix.length, indent, siblings: siblingsOf(lines, li, indent) };
  }
  const valueTyping = /^(\s*)([A-Za-z0-9_.-]+):\s+([A-Za-z0-9_.-]*)$/.exec(before);
  if (valueTyping && /^\s*(#.*)?$/.test(after)) {
    const indent = valueTyping[1]?.length ?? 0;
    const path = parentsOf(lines, li, indent);
    if (!path) return NONE;
    const prefix = valueTyping[3] ?? '';
    return { kind: 'value', path, key: valueTyping[2] ?? '', prefix, from: offset - prefix.length, indent, siblings: siblingsOf(lines, li, indent) };
  }
  return NONE;
}
