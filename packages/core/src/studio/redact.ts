/**
 * What a studio run's audit row keeps of the statement: its SHAPE, with the
 * literals stripped, cut to {@link STUDIO_AUDIT_STATEMENT_MAX}.
 *
 * Why not the full text: audit rows are read by every admin and by the team
 * activity feed, kept for the retention window, and copied into controller
 * backups. A statement's literals are the data itself (`UPDATE users SET
 * ssn = '…'`, `SET apikey sk-…`, `CREATE USER … IDENTIFIED BY '…'`), and the
 * studio's contract is "statement, who, where, how long, how many rows. Never
 * values." Why not a hash: an unkeyed hash of a statement with a short secret
 * literal is a dictionary attack away from the secret, and a hash can't be
 * read in an investigation anyway. The shape keeps what forensics needs:
 * which tables and columns, which statement, which keys of a document, plus
 * the class, kind and row counts already on the row.
 */
import { lexSql, type SqlDialect } from './sql-lex';

export const STUDIO_AUDIT_STATEMENT_MAX = 1000;
const MASK = '?';

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s);

/** SQL: strings and numbers → `?`, comments dropped, layout collapsed to single spaces. */
export function redactSql(sql: string, dialect: SqlDialect): string {
  const lexed = lexSql(sql, dialect);
  if (lexed.error || lexed.source === undefined) {
    // Unreadable (an unterminated string or comment): keep only what precedes the first quote or comment.
    const stop = sql.search(/['"`$#]|--|\/\*/);
    const head = (stop < 0 ? sql : sql.slice(0, stop)).replace(/\s+/g, ' ').trim();
    return `${head} …`.trim();
  }
  const src = lexed.source;
  return lexed.statements
    .map((st) => {
      let out = '';
      let prevEnd = -1;
      for (const t of st.tokens) {
        if (prevEnd >= 0 && t.start > prevEnd) out += ' ';
        out += t.kind === 'string' || t.kind === 'number' ? MASK : src.slice(t.start, t.end);
        prevEnd = t.end;
      }
      return out;
    })
    .join('; ');
}

function maskValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(maskValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, maskValue(x)]));
  return typeof v === 'string' || typeof v === 'number' ? MASK : v;
}

/** Mongo: keys and operators stay, values go; the command's own target (`find: "users"`) stays. */
export function redactMongo(command: string): string {
  let doc: unknown;
  try {
    doc = JSON.parse(command);
  } catch {
    return MASK;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return MASK;
  const entries = Object.entries(doc as Record<string, unknown>);
  const [first, ...rest] = entries;
  if (!first) return '{}';
  const plain = typeof first[1] === 'string' || typeof first[1] === 'number' || typeof first[1] === 'boolean';
  const head: [string, unknown] = [first[0], plain ? first[1] : maskValue(first[1])];
  return JSON.stringify(Object.fromEntries([head, ...rest.map(([k, v]) => [k, maskValue(v)] as const)]));
}

/** Container commands whose second word names the operation (`OBJECT ENCODING k`). */
const REDIS_SUBCOMMANDS = new Set(['OBJECT', 'MEMORY', 'SLOWLOG', 'XINFO', 'LATENCY', 'COMMAND', 'FUNCTION', 'SCRIPT', 'CLUSTER', 'CONFIG', 'CLIENT', 'ACL']);

/** Redis: the command (and sub-command) stay; keys and values become `?`. */
export function redactRedis(argv: readonly string[]): string {
  const cmd = (argv[0] ?? '').toUpperCase();
  const keep = REDIS_SUBCOMMANDS.has(cmd) && argv.length > 1 ? 2 : 1;
  return [cmd, ...argv.slice(1, keep).map((a) => a.toUpperCase()), ...argv.slice(keep).map(() => MASK)].join(' ').trim();
}

export type AuditStatementInput =
  | { kind: 'sql'; statement: string; dialect: SqlDialect }
  | { kind: 'mongo'; command: string }
  | { kind: 'redis'; argv: readonly string[] };

/** The statement text a `studio.query` audit row stores. Pure and browser-safe. */
export function auditStatement(input: AuditStatementInput, max = STUDIO_AUDIT_STATEMENT_MAX): string {
  const text =
    input.kind === 'sql' ? redactSql(input.statement, input.dialect) : input.kind === 'mongo' ? redactMongo(input.command) : redactRedis(input.argv);
  return cut(text, max);
}
