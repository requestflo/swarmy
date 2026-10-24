/**
 * Line mapping for the swarmy.yaml editor (pure): character offsets in the
 * textarea ↔ the 1-based line/column the app-config parser reports, so a
 * problem lands on the line it names and a click on a problem moves the
 * cursor there.
 */

/** Offset of the first character of every line (`[0]` is always 0). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
}

/** 1-based line and column of an offset (clamped to the text). */
export function offsetToPos(starts: readonly number[], offset: number): { line: number; col: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, col: Math.max(0, offset - (starts[lo] ?? 0)) + 1 };
}

/** Offset of a 1-based line/column; a line past the end clamps to the last line. */
export function posToOffset(starts: readonly number[], line: number, col = 1): number {
  const i = Math.min(Math.max(line, 1), starts.length) - 1;
  return (starts[i] ?? 0) + Math.max(col, 1) - 1;
}

/** The text of a 1-based line, without its newline. */
export function lineText(text: string, starts: readonly number[], line: number): string {
  const from = starts[line - 1];
  if (from === undefined) return '';
  const to = starts[line];
  return text.slice(from, to === undefined ? undefined : to - 1);
}

/** Replace one 1-based line (no-op past the end). */
export function replaceLine(text: string, line: number, next: string): string {
  const lines = text.split('\n');
  if (line < 1 || line > lines.length) return text;
  lines[line - 1] = next;
  return lines.join('\n');
}

/** Leading spaces of a line. */
export const indentOf = (line: string): number => line.length - line.trimStart().length;

/**
 * What Enter inserts: a newline plus the current line's indent, two more
 * when the line opens a block (`resources:`), so a new key starts in place.
 */
export function newlineFor(lineBefore: string): string {
  const indent = indentOf(lineBefore);
  const opens = /:\s*(#.*)?$/.test(lineBefore) && !/^\s*#/.test(lineBefore);
  return `\n${' '.repeat(indent + (opens ? 2 : 0))}`;
}
