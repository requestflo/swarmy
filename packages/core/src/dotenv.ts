/**
 * Bulk `.env` paste: a PURE parser + diff (no I/O). Browser-safe — the
 * dashboard's env editors use it to turn a pasted block into a previewable
 * added/changed/removed diff that is applied in ONE deploy.
 *
 * Parser semantics (the common subset of dotenv / docker `--env-file` /
 * compose, documented so a paste never surprises):
 *  - blank lines and `# comments` are skipped; an optional `export ` prefix is
 *    stripped; spaces around `=` are allowed;
 *  - unquoted values are trimmed and lose an inline ` # comment`;
 *  - `"double"` values may span lines and interpret `\n \r \t \" \\`;
 *  - `'single'` and `` `backtick` `` values may span lines and are literal;
 *  - `$VAR` / `${VAR}` are NOT interpolated (kept literally) — swarmy never
 *    guesses at another variable's value;
 *  - a duplicate key: the LAST one wins, with a warning naming both lines;
 *  - anything unparseable becomes a located warning, never a throw.
 */

export interface DotenvEntry {
  key: string;
  value: string;
  /** 1-based line where the entry starts. */
  line: number;
}

export interface DotenvWarning {
  line: number;
  message: string;
}

export interface DotenvParseResult {
  /** Deduplicated (last wins), in order of each key's winning occurrence. */
  entries: DotenvEntry[];
  warnings: DotenvWarning[];
}

export interface DotenvParseOptions {
  /** Keys that don't match are skipped with a warning (default: any shell-ish name). */
  keyPattern?: RegExp;
  /** Human description of `keyPattern` for the warning. */
  keyRule?: string;
}

const DEFAULT_KEY = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
/** swarmy service env keys (`EnvVar` in inputs.ts). */
export const SERVICE_ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;

const DQ_ESCAPES: Record<string, string> = { n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\' };

function unescapeDouble(s: string): string {
  return s.replace(/\\([nrt"\\])/g, (_m, c: string) => DQ_ESCAPES[c] ?? c);
}

/** Index of the closing quote in `s` from `from`, honouring `\` escapes for `"`. */
function findClose(s: string, quote: string, from: number): number {
  for (let i = from; i < s.length; i++) {
    const ch = s[i];
    if (quote === '"' && ch === '\\') {
      i++;
      continue;
    }
    if (ch === quote) return i;
  }
  return -1;
}

export function parseDotenv(text: string, opts: DotenvParseOptions = {}): DotenvParseResult {
  const keyPattern = opts.keyPattern ?? DEFAULT_KEY;
  const keyRule = opts.keyRule ?? 'letters, digits and _ starting with a letter or _';
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const warnings: DotenvWarning[] = [];
  const byKey = new Map<string, DotenvEntry>();

  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    const raw = lines[i] ?? '';
    i++;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const body = raw.replace(/^\s+/, '').replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    if (eq <= 0) {
      warnings.push({ line: lineNo, message: `not KEY=value: "${trimmed.slice(0, 40)}"` });
      continue;
    }
    const key = body.slice(0, eq).trim();
    let rest = body.slice(eq + 1).replace(/^[ \t]+/, '');
    let value: string;

    const q = rest[0];
    if (q === '"' || q === "'" || q === '`') {
      // Quoted — may continue over following lines until the closing quote.
      let buf = rest.slice(1);
      let close = findClose(buf, q, 0);
      let j = i;
      while (close < 0 && j < lines.length) {
        buf += `\n${lines[j] ?? ''}`;
        j++;
        close = findClose(buf, q, 0);
      }
      if (close < 0) {
        warnings.push({ line: lineNo, message: `${key}: unterminated ${q} quote — kept the rest of the line as-is` });
        value = rest.slice(1);
      } else {
        i = j;
        const inner = buf.slice(0, close);
        value = q === '"' ? unescapeDouble(inner) : inner;
        const after = buf.slice(close + 1).trim();
        if (after && !after.startsWith('#')) {
          warnings.push({ line: lineNo, message: `${key}: ignored text after the closing quote` });
        }
      }
    } else {
      const hash = rest.search(/\s#/);
      if (hash >= 0) rest = rest.slice(0, hash);
      value = rest.trim();
    }

    if (!keyPattern.test(key)) {
      warnings.push({ line: lineNo, message: `${key}: invalid name (${keyRule}) — skipped` });
      continue;
    }
    const prev = byKey.get(key);
    if (prev) {
      warnings.push({ line: lineNo, message: `${key} is also set on line ${prev.line} — using line ${lineNo}` });
      byKey.delete(key); // re-insert so order follows the winning occurrence
    }
    byKey.set(key, { key, value, line: lineNo });
  }
  return { entries: [...byKey.values()], warnings };
}

// ── Secret heuristics ────────────────────────────────────────────────────────

const SECRET_KEY =
  /(SECRET|PASSW(OR)?D|PWD|TOKEN|API_?KEY|ACCESS_?KEY|PRIVATE|CREDENTIAL|(^|_)AUTH(_|$)|SALT|SIGNING|WEBHOOK|DSN|(^|_)KEY$|^PASS$)/i;
const PUBLIC_KEY = /(^|_)PUBLIC(_|$)|^NEXT_PUBLIC_|^VITE_|^PUBLIC_/i;
const SECRET_VALUE = [
  /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]*:[^/\s@]+@/i, // URL with an inline password
  /^(sk|rk)_(live|test)_[A-Za-z0-9]{8,}/, // Stripe
  /^gh[pousr]_[A-Za-z0-9]{20,}/, // GitHub tokens
  /^github_pat_/,
  /^xox[abprs]-/, // Slack
  /^AKIA[0-9A-Z]{16}$/, // AWS access key id
  /^glpat-/, // GitLab
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Should this variable default to "secret" (masked)? Key name first, then value shape. */
export function looksSecret(key: string, value = ''): boolean {
  if (SECRET_VALUE.some((re) => re.test(value))) return true;
  if (PUBLIC_KEY.test(key)) return false;
  return SECRET_KEY.test(key);
}

// ── Diff ─────────────────────────────────────────────────────────────────────

export type EnvChangeKind = 'added' | 'changed' | 'removed' | 'unchanged';

export interface EnvDiffRow {
  key: string;
  kind: EnvChangeKind;
  before?: string;
  after?: string;
  /** Default mask suggestion (`looksSecret`); the UI lets the user flip it. */
  secret: boolean;
}

export interface EnvDiff {
  rows: EnvDiffRow[];
  /** The env to deploy (current ⊕ paste, per mode). */
  next: Record<string, string>;
  counts: Record<EnvChangeKind, number>;
}

/**
 * Diff a paste against the current env. `merge` (default) keeps keys the paste
 * doesn't mention; `replace` removes them. Rows: current keys in their order,
 * then new keys in paste order.
 */
export function diffEnv(
  current: Record<string, string>,
  incoming: readonly { key: string; value: string }[],
  mode: 'merge' | 'replace' = 'merge',
): EnvDiff {
  const inc = new Map(incoming.map((e) => [e.key, e.value]));
  const rows: EnvDiffRow[] = [];
  const next: Record<string, string> = {};
  for (const [key, before] of Object.entries(current)) {
    if (inc.has(key)) {
      const after = inc.get(key) ?? '';
      rows.push({ key, kind: after === before ? 'unchanged' : 'changed', before, after, secret: looksSecret(key, after) });
      next[key] = after;
    } else if (mode === 'replace') {
      rows.push({ key, kind: 'removed', before, secret: looksSecret(key, before) });
    } else {
      rows.push({ key, kind: 'unchanged', before, after: before, secret: looksSecret(key, before) });
      next[key] = before;
    }
  }
  for (const [key, after] of inc) {
    if (key in current) continue;
    rows.push({ key, kind: 'added', after, secret: looksSecret(key, after) });
    next[key] = after;
  }
  const counts: Record<EnvChangeKind, number> = { added: 0, changed: 0, removed: 0, unchanged: 0 };
  for (const r of rows) counts[r.kind]++;
  return { rows, next, counts };
}

/** Mask a value for display (keeps length hint coarse, never the content). */
export function maskValue(value: string): string {
  return value ? '•'.repeat(Math.min(12, Math.max(6, value.length))) : '';
}
