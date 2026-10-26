/**
 * A docker-compose file read line by line, so a 4 KB probe cut mid-file still
 * reads: each service's image, command, build, labels (`labels:` and
 * `deploy.labels:`, list or map form) and environment, with the lines they
 * sit on. Not a YAML parser — anchors, merges and multi-line scalars are
 * skipped, which only means fewer facts.
 */
import { ev } from './files';
import type { Fact } from './context';
import type { Evidence, ScanFile, ScanLine } from './types';

export { COMPOSE_FILES } from './files';

export interface ComposeService {
  name: string;
  /** `build:` — the app's own code. */
  build?: Evidence;
  /** value = the image ref. */
  image?: Fact;
  /** value = the command as one line. */
  command?: Fact;
  /** name = label key, value = label value. */
  labels: Fact[];
  /** name = variable, value = its value ('' when only named). */
  env: Fact[];
}

const unquote = (s: string): string => s.trim().replace(/^(['"])(.*)\1$/, '$2');

/** `["node", "x.js"]` → `node x.js`; anything else unquoted. */
function oneLine(v: string): string {
  const t = v.trim();
  if (!t.startsWith('[')) return unquote(t);
  return t
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map(unquote)
    .filter(Boolean)
    .join(' ');
}

/** `KEY=value` / `KEY: value` (a list item), or `KEY: value` (a map entry). */
function pairOf(t: string, item: boolean): [string, string] | null {
  const s = item ? unquote(t) : t;
  const m = item ? /^([^=:\s]+)\s*(?:=|:\s)\s*(.*)$/.exec(s) ?? /^([^=:\s]+)$/.exec(s) : /^(['"]?)([^'"\s:]+)\1\s*:\s*(.*)$/.exec(s);
  if (!m) return null;
  return item ? [m[1]!, unquote(m[2] ?? '')] : [m[2]!, unquote(m[3] ?? '')];
}

export function composeServices(f: ScanFile): ComposeService[] {
  const out: ComposeService[] = [];
  const fact = (name: string, value: string, l: ScanLine): Fact => ({ name, value, ev: ev(f, l) });
  let inServices = false;
  let svcIndent = -1;
  let cur: ComposeService | null = null;
  let block: { key: 'labels' | 'env' | 'command'; indent: number } | null = null;
  for (const l of f.lines) {
    const raw = l.text.replace(/\t/g, '  ');
    const t = raw.trim();
    if (!t || t.startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      inServices = /^services\s*:\s*$/.test(t);
      cur = null;
      block = null;
      svcIndent = -1;
      continue;
    }
    if (!inServices) continue;
    if (svcIndent < 0 || indent <= svcIndent) {
      const m = /^([A-Za-z0-9._-]+)\s*:\s*$/.exec(t);
      cur = m && (svcIndent < 0 || indent === svcIndent) ? { name: m[1]!, labels: [], env: [] } : null;
      if (cur) {
        svcIndent = indent;
        out.push(cur);
      }
      block = null;
      continue;
    }
    if (!cur) continue;
    if (block && indent > block.indent) {
      const item = /^-\s+(.*)$/.exec(t)?.[1];
      if (block.key === 'command') {
        if (item !== undefined && cur.command) cur.command.value = `${cur.command.value} ${unquote(item)}`.trim();
        continue;
      }
      const pair = pairOf(item ?? t, item !== undefined);
      if (pair) (block.key === 'labels' ? cur.labels : cur.env).push(fact(pair[0], pair[1], l));
      continue;
    }
    block = null;
    const kv = /^([A-Za-z_][\w.-]*)\s*:\s*(.*)$/.exec(t);
    if (!kv) continue;
    const [, key, rest = ''] = kv;
    if (key === 'image' && rest) cur.image = fact('image', unquote(rest), l);
    else if (key === 'build') cur.build = ev(f, l);
    else if (key === 'command') {
      cur.command = fact('command', rest ? oneLine(rest) : '', l);
      if (!rest) block = { key: 'command', indent };
    } else if ((key === 'labels' || key === 'environment') && !rest) block = { key: key === 'labels' ? 'labels' : 'env', indent };
  }
  return out;
}
