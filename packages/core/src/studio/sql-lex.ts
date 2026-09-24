/**
 * A small SQL lexer for statement classification — not a parser. It knows
 * exactly enough to never mistake text for code or code for text:
 *
 *  - comments: `-- …`, `/* … *\/` (nested in Postgres), `#` (MySQL);
 *  - MySQL executable comments `/*! … *\/` / `/*M! … *\/` ARE code (the server
 *    runs them) — their body is lexed inline;
 *  - strings: `'…'` (doubled quotes), Postgres `E'…'` (backslash escapes),
 *    MySQL `'…'` / `"…"` (backslash escapes), Postgres dollar quotes `$tag$…$tag$`;
 *  - quoted identifiers: `"…"` (Postgres), `` `…` `` (MySQL);
 *  - `;` at top level splits statements.
 *
 * Unterminated strings/comments are reported, never guessed at.
 */
export type SqlDialect = 'postgres' | 'mysql';

export type SqlTokenKind = 'word' | 'ident' | 'string' | 'number' | 'punct' | 'param' | 'backslash';

export interface SqlToken {
  kind: SqlTokenKind;
  /** Upper-cased for `word`, raw otherwise (strings/idents unquoted). */
  value: string;
  /** Parenthesis depth the token sits at (within its statement). */
  depth: number;
}

export interface LexedStatement {
  tokens: SqlToken[];
  /** The statement text as written (comments included, no trailing `;`). */
  text: string;
}

export interface LexResult {
  statements: LexedStatement[];
  error?: string;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);

export function lexSql(input: string, dialect: SqlDialect): LexResult {
  const statements: LexedStatement[] = [];
  let tokens: SqlToken[] = [];
  let depth = 0;
  let stmtStart = 0;
  let i = 0;
  const n = input.length;
  const my = dialect === 'mysql';

  const push = (kind: SqlTokenKind, value: string) => tokens.push({ kind, value, depth });
  const endStatement = (end: number) => {
    if (tokens.length > 0) statements.push({ tokens, text: input.slice(stmtStart, end).trim() });
    tokens = [];
    depth = 0;
    stmtStart = end + 1;
  };

  /** Read a quoted run starting at i (the opening quote). Returns the index after the close, or -1. */
  const readQuoted = (q: string, backslash: boolean): { end: number; body: string } | null => {
    let j = i + 1;
    let body = '';
    while (j < n) {
      const c = input[j]!;
      if (backslash && c === '\\') {
        body += input[j + 1] ?? '';
        j += 2;
        continue;
      }
      if (c === q) {
        if (input[j + 1] === q) {
          body += q;
          j += 2;
          continue;
        }
        return { end: j + 1, body };
      }
      body += c;
      j++;
    }
    return null;
  };

  while (i < n) {
    const c = input[i]!;
    const next = input[i + 1] ?? '';

    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // line comments
    // MySQL only treats `--` as a comment when whitespace (or the end) follows:
    // `SELECT 1--1; DROP TABLE t` is two statements there.
    const dashComment = c === '-' && next === '-' && (!my || i + 2 >= n || /[\s\x00-\x1f]/.test(input[i + 2]!));
    if (dashComment || (my && c === '#')) {
      const nl = input.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    // block comments (+ MySQL executable comments, which are code)
    if (c === '/' && next === '*') {
      if (my) {
        const exec = /^\/\*(M?!)(\d{5,6})?/.exec(input.slice(i, i + 10));
        if (exec) {
          // Lex the body inline: drop the opener here and the matching `*/` when met.
          const close = input.indexOf('*/', i + 2);
          if (close < 0) return { statements, error: 'unterminated comment' };
          input = input.slice(0, i) + ' ' + input.slice(i + exec[0].length, close) + ' ' + input.slice(close + 2);
          return lexSql(input, dialect);
        }
        const close = input.indexOf('*/', i + 2);
        if (close < 0) return { statements, error: 'unterminated comment' };
        i = close + 2;
        continue;
      }
      // Postgres block comments nest.
      let d = 1;
      let j = i + 2;
      while (j < n && d > 0) {
        if (input[j] === '/' && input[j + 1] === '*') {
          d++;
          j += 2;
        } else if (input[j] === '*' && input[j + 1] === '/') {
          d--;
          j += 2;
        } else j++;
      }
      if (d > 0) return { statements, error: 'unterminated comment' };
      i = j;
      continue;
    }
    // strings
    if (c === "'" || (my && c === '"')) {
      const r = readQuoted(c, my);
      if (!r) return { statements, error: 'unterminated string' };
      push('string', r.body);
      i = r.end;
      continue;
    }
    if (!my && (c === 'E' || c === 'e') && next === "'") {
      i++;
      const r = readQuoted("'", true);
      if (!r) return { statements, error: 'unterminated string' };
      push('string', r.body);
      i = r.end;
      continue;
    }
    if (!my && c === '"') {
      const r = readQuoted('"', false);
      if (!r) return { statements, error: 'unterminated identifier' };
      push('ident', r.body);
      i = r.end;
      continue;
    }
    if (my && c === '`') {
      const r = readQuoted('`', false);
      if (!r) return { statements, error: 'unterminated identifier' };
      push('ident', r.body);
      i = r.end;
      continue;
    }
    // Postgres dollar quotes ($$…$$, $tag$…$tag$) vs positional params ($1).
    if (!my && c === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(input.slice(i));
      if (m) {
        const tag = m[0];
        const close = input.indexOf(tag, i + tag.length);
        if (close < 0) return { statements, error: 'unterminated dollar-quoted string' };
        push('string', input.slice(i + tag.length, close));
        i = close + tag.length;
        continue;
      }
      const p = /^\$\d+/.exec(input.slice(i));
      if (p) {
        push('param', p[0]);
        i += p[0].length;
        continue;
      }
    }
    if (c === '\\') {
      // psql meta-command / mysql client command — never valid server SQL.
      push('backslash', input.slice(i, i + 2));
      i += 2;
      continue;
    }
    if (c === ';') {
      endStatement(i);
      i++;
      continue;
    }
    if (c === '(') {
      push('punct', c);
      depth++;
      i++;
      continue;
    }
    if (c === ')') {
      depth = Math.max(0, depth - 1);
      push('punct', c);
      i++;
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(next))) {
      let j = i + 1;
      while (j < n && /[0-9.eE_xXa-fA-F]/.test(input[j]!)) j++;
      push('number', input.slice(i, j));
      i = j;
      continue;
    }
    if (isWordStart(c)) {
      let j = i + 1;
      while (j < n && isWordChar(input[j]!)) j++;
      push('word', input.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    // Operators and other punctuation, one char at a time (`=`, `,`, `.`, `@`, …).
    push('punct', c);
    i++;
  }
  endStatement(n);
  return { statements };
}
