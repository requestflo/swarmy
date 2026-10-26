import type { DotenvWarning } from '@swarmy/core';
import type { PasteRow } from './paste-target';

/**
 * The paste page's view of the shared parser + diff (`parseDotenv`/`diffEnv`
 * in @swarmy/core): gutter marks per line and the change groups. PURE.
 */
export type LineMark = 'error' | 'warn';

/** A note the parser skipped a line for is an error; anything it kept with a caveat is a warning. */
export function markOf(w: DotenvWarning): LineMark {
  return /skipped|^not KEY=value/.test(w.message) ? 'error' : 'warn';
}

/** line number → its worst mark. */
export function lineMarks(warnings: readonly DotenvWarning[]): Map<number, LineMark> {
  const out = new Map<number, LineMark>();
  for (const w of warnings) if (out.get(w.line) !== 'error') out.set(w.line, markOf(w));
  return out;
}

export interface ChangeGroup {
  key: 'secrets' | 'added' | 'changed' | 'removed' | 'locked' | 'kept';
  title: string;
  rows: PasteRow[];
}

/**
 * Secrets detected (new or changed values that will be stored as secrets),
 * then the rest added / changed, then removed (Replace all only), then what
 * the paste names but won't write: rows swarmy.yaml declares (locked) and,
 * pasting to every environment, values an environment sets for itself
 * (kept). Unchanged rows are only counted.
 */
export function changeGroups(rows: readonly PasteRow[], secret: ReadonlySet<string>): ChangeGroup[] {
  const moving = rows.filter((r) => r.kind === 'added' || r.kind === 'changed');
  const groups: ChangeGroup[] = [
    { key: 'secrets', title: 'Secrets detected', rows: moving.filter((r) => r.secret || secret.has(r.key)) },
    { key: 'added', title: 'Added', rows: moving.filter((r) => r.kind === 'added' && !r.secret && !secret.has(r.key)) },
    { key: 'changed', title: 'Changed', rows: moving.filter((r) => r.kind === 'changed' && !r.secret && !secret.has(r.key)) },
    { key: 'removed', title: 'Removed', rows: rows.filter((r) => r.kind === 'removed') },
    { key: 'locked', title: 'Managed by swarmy.yaml — edit in git', rows: rows.filter((r) => r.kind === 'locked') },
    { key: 'kept', title: 'Kept · this environment sets its own', rows: rows.filter((r) => r.kind === 'kept') },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** "+3 added · 2 changed · 4 same · 1 not in the paste · 2 notes" (merge keeps what the paste doesn't name), then locked / kept when any. */
export function changeSummary(rows: readonly PasteRow[], pasted: ReadonlySet<string>, notes: number, replace: boolean): string {
  const n = (k: PasteRow['kind']): number => rows.filter((r) => r.kind === k).length;
  const same = rows.filter((r) => r.kind === 'unchanged' && pasted.has(r.key)).length;
  const absent = rows.filter((r) => r.kind === 'removed' || (r.kind === 'unchanged' && !pasted.has(r.key))).length;
  return [
    `+${n('added')} added`,
    `${n('changed')} changed`,
    `${same} same`,
    // Replace all keeps what swarmy.yaml declares, so only real removals count as removed.
    replace ? `${n('removed')} removed` : `${absent} not in the paste`,
    ...(n('locked') ? [`${n('locked')} locked`] : []),
    ...(n('kept') ? [`${n('kept')} kept`] : []),
    `${notes} ${notes === 1 ? 'note' : 'notes'}`,
  ].join(' · ');
}
