/** Minimal .env read/write for `env pull` / `env push` (no interpolation). */

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!KEY_RE.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const q = value[0];
    if (q === '"' || q === "'") {
      // Up to the closing quote (multi-line allowed); anything after it is a comment.
      let rest = value.slice(1);
      let end = closingQuote(rest, q);
      while (end < 0 && i + 1 < lines.length) {
        rest += `\n${lines[++i]}`;
        end = closingQuote(rest, q);
      }
      const body = end < 0 ? rest : rest.slice(0, end);
      value =
        q === '"'
          ? body.replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c))
          : body;
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Index of the unescaped closing quote in `s`, or -1. */
function closingQuote(s: string, q: string): number {
  for (let i = 0; i < s.length; i++) {
    if (q === '"' && s[i] === '\\') {
      i++;
      continue;
    }
    if (s[i] === q) return i;
  }
  return -1;
}

export function quoteDotenv(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

export function serializeDotenv(vars: Array<{ key: string; value: string | null; note?: string }>, header?: string): string {
  const out: string[] = [];
  if (header) out.push(...header.split('\n').map((l) => `# ${l}`), '');
  for (const v of vars) {
    if (v.value === null) out.push(`# ${v.key}=${v.note ? `  (${v.note})` : ''}`);
    else out.push(`${v.key}=${quoteDotenv(v.value)}`);
  }
  return `${out.join('\n')}\n`;
}
