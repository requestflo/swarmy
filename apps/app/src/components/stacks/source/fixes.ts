import type { ConfigIssue } from '@swarmy/app-config';
import { lineStarts, lineText, replaceLine } from './editor-lines';
import { mappingAt } from './schema-complete';

/**
 * A one-click "Fix" for a parser problem — only when the problem itself
 * names the right answer: an unknown key next to the schema's keys there,
 * a value outside the options the parser lists ("Expected 'small' | …",
 * "type must be one of …", "use one of url, ro_url …"), or `version`. The
 * closest option wins only when it's a near miss; otherwise no guess.
 */
export interface Fix {
  /** What the fix writes ("replicas"). */
  to: string;
  line: number;
  apply: (text: string) => string;
}

export function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0] ?? 0;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j] ?? 0;
      row[j] = Math.min(cur + 1, (row[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length] ?? 0;
}

/** The option a typo was reaching for, or null when nothing is close. */
export function nearest(bad: string, options: readonly string[]): string | null {
  const low = bad.toLowerCase();
  let best: { opt: string; d: number } | null = null;
  for (const opt of options) {
    if (opt === bad) continue;
    const d = opt.toLowerCase() === low ? 0 : editDistance(low, opt.toLowerCase());
    if (!best || d < best.d) best = { opt, d };
  }
  if (!best) return null;
  const near = best.d <= Math.max(1, Math.floor(bad.length / 3)) || (low.length >= 3 && best.opt.startsWith(low));
  return near ? best.opt : null;
}

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The options and the offending word a message spells out. */
function optionsIn(message: string): { options: string[]; bad?: string } | null {
  const zodEnum = /Expected (.+), received '([^']*)'/.exec(message);
  if (zodEnum?.[1]) return { options: zodEnum[1].split(' | ').map((o) => o.replace(/^'|'$/g, '')), bad: zodEnum[2] ?? '' };
  const typeOf = /^type must be one of (.+)$/.exec(message);
  if (typeOf?.[1]) return { options: typeOf[1].split(', ') };
  const field = /has no "([^"]+)" — use one of (.+)$/.exec(message) ?? /ha(?:ve|s) (.+) — not "([^"]+)"$/.exec(message);
  if (field && message.includes('use one of')) return { options: (field[2] ?? '').split(', '), bad: field[1] ?? '' };
  if (field) return { options: (field[1] ?? '').split(', '), bad: field[2] ?? '' };
  return null;
}

export function fixFor(issue: ConfigIssue, text: string): Fix | null {
  if (!issue.line) return null;
  const starts = lineStarts(text);
  const at = (line: number): string => lineText(text, starts, line);
  const fix = (line: number, to: string, next: string): Fix | null =>
    next === at(line) ? null : { to, line, apply: (t) => replaceLine(t, line, next) };

  const unknown = /^unknown key "([^"]+)"$/.exec(issue.message);
  if (unknown?.[1]) {
    const bad = unknown[1];
    const parent = issue.path.slice(0, -1).map(String);
    const known = mappingAt(parent).nodes.flatMap((n) => Object.keys(n.properties ?? {}));
    const to = nearest(bad, known);
    if (!to) return null;
    // A block value starts on the next line, so the key may sit a line or two above.
    const keyRe = new RegExp(`^(\\s*(?:- )?)${esc(bad)}(\\s*:)`);
    for (let l = issue.line; l >= Math.max(1, issue.line - 2); l--) if (keyRe.test(at(l))) return fix(l, to, at(l).replace(keyRe, `$1${to}$2`));
    return null;
  }
  if (issue.message === 'version must be 1') return fix(issue.line, '1', at(issue.line).replace(/^(\s*version:\s*).*$/, '$11'));

  const opts = optionsIn(issue.message);
  if (!opts) return null;
  const line = at(issue.line);
  const bad = opts.bad ?? /:\s*([^\s#]+)/.exec(line)?.[1] ?? '';
  const to = bad ? nearest(bad, opts.options) : null;
  if (!to) return null;
  const binding = new RegExp(`(\\$\\{\\{\\s*[^}]*\\.)${esc(bad)}(\\s*\\}\\})`);
  if (binding.test(line)) return fix(issue.line, to, line.replace(binding, `$1${to}$2`));
  return fix(issue.line, to, line.replace(new RegExp(`(:\\s*["']?)${esc(bad)}(["']?\\s*(#.*)?)$`), `$1${to}$2`));
}
