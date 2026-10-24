/**
 * One swarmy.yaml line → coloured spans for the editor's backdrop (pure).
 * Keys, plain strings, numbers/booleans, `${{ bindings }}` and comments; the
 * spans always concatenate back to the exact line, so the transparent
 * textarea on top lines up character for character.
 */
export type TokenClass = 'key' | 'string' | 'number' | 'binding' | 'comment' | 'plain';
export interface Token {
  text: string;
  cls: TokenClass;
}

const KEY = /^(\s*(?:- )?)([^\s:#'"{[][^:#]*?)(:)(?=\s|$)/;
const LITERAL = /^(-?\d+(\.\d+)?|true|false|null|~)$/;
const BINDING = /\$?\$\{\{[^}]*\}\}/g;

function valueTokens(v: string): Token[] {
  const comment = /(^|\s)#.*$/.exec(v);
  const body = comment ? v.slice(0, comment.index + (comment[1]?.length ?? 0)) : v;
  const out: Token[] = [];
  const trimmed = body.trim();
  if (LITERAL.test(trimmed)) {
    const lead = body.indexOf(trimmed);
    out.push({ text: body.slice(0, lead), cls: 'plain' }, { text: trimmed, cls: 'number' }, { text: body.slice(lead + trimmed.length), cls: 'plain' });
  } else {
    let at = 0;
    for (const m of body.matchAll(BINDING)) {
      out.push({ text: body.slice(at, m.index), cls: 'string' }, { text: m[0], cls: 'binding' });
      at = (m.index ?? 0) + m[0].length;
    }
    out.push({ text: body.slice(at), cls: 'string' });
  }
  if (comment) out.push({ text: v.slice(body.length), cls: 'comment' });
  return out.filter((t) => t.text !== '').map((t) => (t.text.trim() === '' ? { ...t, cls: 'plain' } : t));
}

export function highlightLine(line: string): Token[] {
  if (/^\s*#/.test(line)) return [{ text: line, cls: 'comment' }];
  const k = KEY.exec(line);
  if (k) {
    const rest = line.slice(k[0].length);
    return [
      { text: k[1] ?? '', cls: 'plain' as const },
      { text: k[2] ?? '', cls: 'key' as const },
      { text: k[3] ?? '', cls: 'plain' as const },
      ...valueTokens(rest),
    ].filter((t) => t.text !== '');
  }
  const item = /^(\s*- )(.*)$/.exec(line);
  if (item) return [{ text: item[1] ?? '', cls: 'plain' as const }, ...valueTokens(item[2] ?? '')].filter((t) => t.text !== '');
  return line ? valueTokens(line) : [];
}

/**
 * 1-based lines of `next` that aren't in `prev` (a longest-common-subsequence
 * line diff), for the editor's "changed since the saved file" wash.
 */
export function changedLines(prev: string, next: string): Set<number> {
  const a = prev.split('\n');
  const b = next.split('\n');
  if (a.length * b.length > 4_000_000) return new Set();
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] ?? 0) + 1 : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
  const out = new Set<number>();
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) {
      i++;
      j++;
    } else if (i < a.length && (dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) i++;
    else out.add(++j);
  }
  return out;
}
