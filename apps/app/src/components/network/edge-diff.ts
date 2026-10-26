import { diffLines, type DiffLine } from '@/components/configsmgr/line-diff';

/**
 * Two edges' Caddyfiles as a unified diff (the `diff -u` shape, `context`
 * lines around each change), so it reads and copies like the real tool's
 * output. Null when the files are the same, byte for byte. Pure.
 */
export function edgeDiff(a: { label: string; text: string }, b: { label: string; text: string }, context = 3): string | null {
  const lines = diffLines(a.text, b.text);
  const changed = lines.map((l) => l.op !== 'same');
  if (!changed.includes(true)) return null;
  const out = [`--- ${a.label}`, `+++ ${b.label}`];
  let i = 0;
  while (i < lines.length) {
    if (!changed[i]) {
      i += 1;
      continue;
    }
    const start = Math.max(0, i - context);
    let end = i;
    // Merge the next change into this hunk while the gap between them is short.
    for (;;) {
      let next = end + 1;
      while (next < lines.length && !changed[next]) next += 1;
      if (next >= lines.length || next - end > 2 * context) break;
      end = next;
    }
    const stop = Math.min(lines.length, end + context + 1);
    out.push(hunkHeader(lines, start, stop), ...lines.slice(start, stop).map(prefixed));
    i = stop;
  }
  return out.join('\n');
}

function prefixed(l: DiffLine): string {
  return `${l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '}${l.text}`;
}

/** `@@ -oldStart,oldCount +newStart,newCount @@` for lines[start, stop). */
function hunkHeader(lines: DiffLine[], start: number, stop: number): string {
  const before = lines.slice(0, start);
  const hunk = lines.slice(start, stop);
  const oldBefore = before.filter((l) => l.op !== 'add').length;
  const newBefore = before.filter((l) => l.op !== 'del').length;
  const oldCount = hunk.filter((l) => l.op !== 'add').length;
  const newCount = hunk.filter((l) => l.op !== 'del').length;
  const range = (at: number, n: number): string => `${n ? at + 1 : at},${n}`;
  return `@@ -${range(oldBefore, oldCount)} +${range(newBefore, newCount)} @@`;
}
