/**
 * Tiny line diff for the configs editor's "Preview changes" view.
 *
 * Deliberately local to components/configsmgr: the manifest forbids importing
 * D1's release-diff internals across slices, so this ~80-line LCS diff is
 * duplicated by design (noted in the slice report). Pure + unit-tested.
 */

export type DiffOp = 'same' | 'add' | 'del';

export interface DiffLine {
  op: DiffOp;
  text: string;
  /** 1-based line number in the OLD text (same/del rows). */
  oldLine?: number;
  /** 1-based line number in the NEW text (same/add rows). */
  newLine?: number;
}

/** Guard for the O(n*m) LCS table — beyond this we fall back to del-all/add-all. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  // A trailing newline should not create a phantom empty line.
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Line-level diff of two texts: common prefix/suffix are matched cheaply, the
 * middle goes through a classic LCS. Output is a unified sequence of rows —
 * `same` rows carry both line numbers, `del`/`add` carry old/new respectively.
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);

  // Trim common prefix/suffix so the LCS only sees the changed middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const out: DiffLine[] = [];
  for (let i = 0; i < start; i += 1) {
    out.push({ op: 'same', text: a[i]!, oldLine: i + 1, newLine: i + 1 });
  }

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const pairs = lcsPairs(midA, midB);

  let ai = 0;
  let bi = 0;
  const emitMid = (toA: number, toB: number): void => {
    while (ai < toA) {
      out.push({ op: 'del', text: midA[ai]!, oldLine: start + ai + 1 });
      ai += 1;
    }
    while (bi < toB) {
      out.push({ op: 'add', text: midB[bi]!, newLine: start + bi + 1 });
      bi += 1;
    }
  };
  for (const [pa, pb] of pairs) {
    emitMid(pa, pb);
    out.push({ op: 'same', text: midA[pa]!, oldLine: start + pa + 1, newLine: start + pb + 1 });
    ai = pa + 1;
    bi = pb + 1;
  }
  emitMid(midA.length, midB.length);

  const tail = a.length - endA;
  for (let i = 0; i < tail; i += 1) {
    out.push({
      op: 'same',
      text: a[endA + i]!,
      oldLine: endA + i + 1,
      newLine: endB + i + 1,
    });
  }
  return out;
}

/** Matched (indexA, indexB) pairs of a longest common subsequence. */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  if (a.length === 0 || b.length === 0) return [];
  if (a.length * b.length > MAX_LCS_CELLS) return []; // fallback: everything changed

  const w = b.length + 1;
  // Row-major (a.length+1) x (b.length+1) table of LCS lengths.
  const table = new Uint32Array((a.length + 1) * w);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i * w + j] =
        a[i] === b[j]
          ? table[(i + 1) * w + j + 1]! + 1
          : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Added/removed counts for the "+3 −1" summary chip. */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const l of lines) {
    if (l.op === 'add') added += 1;
    else if (l.op === 'del') removed += 1;
  }
  return { added, removed };
}
