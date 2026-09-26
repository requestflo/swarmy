/**
 * A small, pure parser for the Prometheus text exposition format (0.0.4) —
 * enough to read Caddy's `/metrics` on an edge node (Q4 per-edge request
 * counting). Comments (`# HELP`/`# TYPE`) and blank lines are skipped; a line
 * that does not parse is skipped rather than failing the whole scrape.
 */

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const NAME_RE = /^[a-zA-Z_:][a-zA-Z0-9_:]*/;
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*/;

function parseValue(raw: string): number | undefined {
  switch (raw) {
    case 'NaN':
      return Number.NaN;
    case '+Inf':
    case 'Inf':
      return Number.POSITIVE_INFINITY;
    case '-Inf':
      return Number.NEGATIVE_INFINITY;
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(raw)) return undefined;
  return Number(raw);
}

/** Parse one sample line; undefined when it is not a well-formed sample. */
export function parsePrometheusLine(line: string): PromSample | undefined {
  const s = line.trim();
  if (s === '' || s.startsWith('#')) return undefined;
  const nameMatch = NAME_RE.exec(s);
  if (!nameMatch) return undefined;
  const name = nameMatch[0];
  let i = name.length;
  const labels: Record<string, string> = {};
  if (s[i] === '{') {
    i++;
    for (;;) {
      while (s[i] === ' ' || s[i] === ',') i++;
      if (s[i] === '}') {
        i++;
        break;
      }
      const ln = LABEL_NAME_RE.exec(s.slice(i));
      if (!ln) return undefined;
      i += ln[0].length;
      while (s[i] === ' ') i++;
      if (s[i] !== '=') return undefined;
      i++;
      while (s[i] === ' ') i++;
      if (s[i] !== '"') return undefined;
      i++;
      let v = '';
      for (;;) {
        const c = s[i];
        if (c === undefined) return undefined;
        if (c === '\\') {
          const n = s[i + 1];
          v += n === 'n' ? '\n' : n === '"' ? '"' : n === '\\' ? '\\' : `\\${n ?? ''}`;
          i += 2;
          continue;
        }
        if (c === '"') {
          i++;
          break;
        }
        v += c;
        i++;
      }
      labels[ln[0]] = v;
    }
  }
  const rest = s.slice(i).trim().split(/\s+/);
  const value = rest[0] === undefined ? undefined : parseValue(rest[0]);
  if (value === undefined) return undefined;
  return { name, labels, value };
}

/** Parse a whole exposition body into samples (unparseable lines are dropped). */
export function parsePrometheusText(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const line of text.split('\n')) {
    const sample = parsePrometheusLine(line);
    if (sample) out.push(sample);
  }
  return out;
}
