/**
 * Statement classification for the database studio: is this a READ, a WRITE,
 * or DESTRUCTIVE — and can the studio run it at all?
 *
 *  - read        → `data.read`; runs inside a read-only transaction.
 *  - write       → `data.write`; the exact statement is shown before it runs.
 *  - destructive → `data.destroy` + a typed confirm: DDL, TRUNCATE, DELETE /
 *                  UPDATE without a (non-trivial) WHERE, server administration,
 *                  anything unrecognised.
 *  - blocked     → never runs: several statements chained with `;`, psql /
 *                  mysql client meta-commands, transaction control, file I/O
 *                  on the server host.
 *
 * Conservative by construction: when in doubt a statement is classified UP
 * (read → write → destructive). The controller classifies before it gates and
 * dispatches; the read-only transaction on the agent is the second wall for
 * Postgres/MySQL, the agent-side allowlists the second wall for Mongo/Redis.
 * Pure and browser-safe, so the dashboard shows the same verdict live.
 */
import { lexSql, type SqlDialect, type SqlToken } from './sql-lex';

export type StatementClass = 'read' | 'write' | 'destructive';

export interface Classification {
  class: StatementClass;
  /** Short statement kind for the UI and audit (`SELECT`, `DELETE`, `DROP TABLE`, `find`, `HSET`). */
  kind: string;
  /** Why it is write/destructive (plain words). */
  reasons: string[];
  /** Set ⇒ the studio refuses to run it, with this reason. */
  blocked?: string;
}

const rank: Record<StatementClass, number> = { read: 0, write: 1, destructive: 2 };
const up = (a: StatementClass, b: StatementClass): StatementClass => (rank[b] > rank[a] ? b : a);

// ── SQL ──────────────────────────────────────────────────────────────────────

const READ_FIRST = new Set(['SELECT', 'VALUES', 'TABLE', 'SHOW', 'DESCRIBE', 'DESC', 'EXPLAIN', 'WITH', 'SET', 'HELP']);
const WRITE_FIRST = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'REPLACE', 'UPSERT', 'CALL', 'LOCK', 'COPY', 'LOAD', 'REFRESH', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'ANALYZE', 'VACUUM', 'HANDLER', 'DO']);
const DDL_FIRST = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME', 'COMMENT', 'GRANT', 'REVOKE', 'REINDEX', 'CLUSTER', 'SECURITY', 'IMPORT', 'OPTIMIZE', 'REPAIR']);
const ADMIN_FIRST = new Set(['FLUSH', 'KILL', 'SHUTDOWN', 'INSTALL', 'UNINSTALL', 'RESET', 'PURGE', 'CHANGE', 'START', 'STOP', 'CHECKPOINT', 'DISCARD', 'PREPARE', 'EXECUTE', 'DEALLOCATE', 'REASSIGN', 'CACHE', 'BINLOG', 'CLONE', 'RESTART']);
const TXN_FIRST = new Set(['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'END', 'ABORT', 'XA']);
/** DML keywords that may hide anywhere (data-modifying CTEs, subqueries). */
const DML_ANYWHERE = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE']);

/**
 * Functions with side effects outside the read-only transaction, that read the
 * server host, or that EXECUTE a query given as a string (`query_to_xml('select
 * pg_terminate_backend(…)')` would otherwise hide the call from this lexer).
 */
const DANGEROUS_FUNCS = new Set([
  'PG_TERMINATE_BACKEND', 'PG_CANCEL_BACKEND', 'PG_RELOAD_CONF', 'PG_ROTATE_LOGFILE', 'PG_PROMOTE',
  'PG_READ_FILE', 'PG_READ_BINARY_FILE', 'PG_STAT_FILE', 'PG_SWITCH_WAL', 'PG_CREATE_RESTORE_POINT',
  'PG_DROP_REPLICATION_SLOT', 'PG_CREATE_PHYSICAL_REPLICATION_SLOT', 'PG_CREATE_LOGICAL_REPLICATION_SLOT',
  'PG_LOGICAL_EMIT_MESSAGE', 'PG_WAL_REPLAY_PAUSE', 'PG_WAL_REPLAY_RESUME', 'PG_BACKUP_START', 'PG_BACKUP_STOP',
  'PG_START_BACKUP', 'PG_STOP_BACKUP', 'PG_IMPORT_SYSTEM_COLLATIONS', 'PG_LOG_BACKEND_MEMORY_CONTEXTS',
  'SET_CONFIG', 'TS_STAT',
  'QUERY_TO_XML', 'QUERY_TO_XMLSCHEMA', 'QUERY_TO_XML_AND_XMLSCHEMA',
  'CURSOR_TO_XML', 'CURSOR_TO_XMLSCHEMA',
  'TABLE_TO_XML', 'TABLE_TO_XMLSCHEMA', 'TABLE_TO_XML_AND_XMLSCHEMA',
  'SCHEMA_TO_XML', 'SCHEMA_TO_XMLSCHEMA', 'SCHEMA_TO_XML_AND_XMLSCHEMA',
  'DATABASE_TO_XML', 'DATABASE_TO_XMLSCHEMA', 'DATABASE_TO_XML_AND_XMLSCHEMA',
  'LOAD_FILE', 'SYS_EXEC', 'SYS_EVAL',
]);
/** Whole families: pg_ls_dir/logdir/waldir/…, adminpack pg_file_write/rename/unlink, lo_*, dblink*. */
const DANGEROUS_FUNC_PREFIXES = ['PG_LS_', 'PG_FILE_', 'LO_', 'DBLINK'];

/**
 * The function name a token calls, upper-cased — `word` tokens AND quoted
 * identifiers (`"pg_read_file"(…)`). Quoted Postgres identifiers are
 * case-sensitive, but the dangerous built-ins are all lower-case, so folding
 * only ever classifies UP.
 */
function dangerousCall(t: SqlToken): string | null {
  if (t.kind !== 'word' && t.kind !== 'ident') return null;
  const name = t.value.toUpperCase();
  if (DANGEROUS_FUNCS.has(name) || DANGEROUS_FUNC_PREFIXES.some((p) => name.startsWith(p))) return name;
  return null;
}

/**
 * MySQL `SET` targets a read-mode run may change: session-only, no privilege
 * or persistent effect. Anything else (`SET PASSWORD`, `SET ROLE`, `SET
 * DEFAULT ROLE`, `SET autocommit`, `SET transaction_read_only`) is a write.
 */
const MYSQL_SAFE_SET_VARS = new Set([
  'NAMES', 'CHARACTER', 'CHARSET', 'TIME_ZONE', 'SQL_MODE', 'SQL_SELECT_LIMIT', 'MAX_EXECUTION_TIME',
  'GROUP_CONCAT_MAX_LEN', 'LC_TIME_NAMES', 'SQL_BIG_SELECTS', 'SQL_SAFE_UPDATES', 'MAX_JOIN_SIZE',
  'OPTIMIZER_SEARCH_DEPTH', 'CTE_MAX_RECURSION_DEPTH', 'SQL_QUOTE_SHOW_CREATE', 'DIV_PRECISION_INCREMENT',
]);

/**
 * Classify a MySQL `SET` statement. Returns null when every assignment is a
 * user variable (`@v`) or an allowlisted session variable; otherwise the
 * reason it is a write.
 */
function mysqlSetWrite(tokens: SqlToken[]): string | null {
  // Split the assignments after `SET` on top-level commas.
  const parts: SqlToken[][] = [[]];
  for (const t of tokens.slice(1)) {
    if (t.kind === 'punct' && t.value === ',' && t.depth === 0) parts.push([]);
    else parts[parts.length - 1]!.push(t);
  }
  for (const part of parts) {
    let i = 0;
    const at = (k: number) => part[k];
    const isAt = (k: number) => at(k)?.kind === 'punct' && at(k)!.value === '@';
    if (isAt(0) && !isAt(1)) continue; // user variable `@v = …`
    if (isAt(0) && isAt(1)) {
      // `@@[session.|local.]var`
      i = 2;
      const scope = at(i);
      if (scope?.kind === 'word' && at(i + 1)?.kind === 'punct' && at(i + 1)!.value === '.') {
        if (scope.value !== 'SESSION' && scope.value !== 'LOCAL') return `SET @@${scope.value.toLowerCase()} changes more than this session`;
        i += 2;
      }
    } else if (at(0)?.kind === 'word' && (at(0)!.value === 'SESSION' || at(0)!.value === 'LOCAL')) {
      i = 1;
    }
    const name = at(i);
    const v = name && (name.kind === 'word' || name.kind === 'ident') ? name.value.toUpperCase() : '';
    if (!MYSQL_SAFE_SET_VARS.has(v)) return `SET ${v || '…'} is not a read-only session setting`;
  }
  return null;
}

/** Postgres `SET` forms that change who you are or the transaction's read-only mode. */
function pgSetWrite(w: string[]): string | null {
  const [, a = '', b = ''] = w;
  const target = a === 'SESSION' || a === 'LOCAL' ? b : a;
  if (target === 'ROLE' || (target === 'AUTHORIZATION' && a === 'SESSION') || (a === 'SESSION' && b === 'AUTHORIZATION')) {
    return 'SET ROLE / SESSION AUTHORIZATION changes the acting role';
  }
  if (a === 'SESSION' && b === 'CHARACTERISTICS') return 'SET SESSION CHARACTERISTICS changes transaction defaults';
  if (['TRANSACTION_READ_ONLY', 'DEFAULT_TRANSACTION_READ_ONLY', 'SESSION_AUTHORIZATION', 'ROLE'].includes(target)) {
    return `SET ${target.toLowerCase()} changes the transaction's access`;
  }
  return null;
}

function words(tokens: SqlToken[]): string[] {
  return tokens.filter((t) => t.kind === 'word').map((t) => t.value);
}

/** Is a WHERE at `depth` (after index `from`, before the scope closes) present and non-trivial? */
function whereFor(tokens: SqlToken[], from: number): 'none' | 'trivial' | 'ok' {
  const depth = tokens[from]!.depth;
  for (let k = from + 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.depth < depth) break; // left the scope (closing paren of a CTE / subquery)
    if (t.depth !== depth) continue;
    if (t.kind === 'word' && (t.value === 'RETURNING' || t.value === 'LIMIT' || t.value === 'ORDER')) {
      // RETURNING/LIMIT end the predicate; keep looking only for WHERE before them.
      if (t.value === 'RETURNING') break;
    }
    if (t.kind === 'word' && t.value === 'WHERE') {
      // Collect the predicate at this depth up to RETURNING / ORDER / LIMIT / end of scope.
      const pred: string[] = [];
      for (let m = k + 1; m < tokens.length; m++) {
        const p = tokens[m]!;
        if (p.depth < depth) break;
        if (p.depth === depth && p.kind === 'word' && ['RETURNING', 'ORDER', 'LIMIT'].includes(p.value)) break;
        pred.push(p.kind === 'string' ? `'${p.value}'` : p.value);
      }
      const s = pred.join(' ').replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
      if (/^(TRUE|1|NOT FALSE|1 = 1|'1' = '1'|'A' = 'A'|1 > 0|0 = 0|1 IS NOT NULL)$/.test(s)) return 'trivial';
      return 'ok';
    }
  }
  return 'none';
}

function classifySqlStatement(tokens: SqlToken[], dialect: SqlDialect): Classification {
  const reasons: string[] = [];
  const bs = tokens.find((t) => t.kind === 'backslash');
  if (bs) {
    return {
      class: 'destructive',
      kind: bs.value,
      reasons: [],
      blocked: `client meta-commands (${bs.value}) are not available in the studio`,
    };
  }
  const w = words(tokens);
  const first = w[0] ?? '';
  const second = w[1] ?? '';
  let cls: StatementClass = 'read';
  let kind = first;

  if (!first) return { class: 'destructive', kind: '?', reasons: ['unrecognised statement'] };
  if (TXN_FIRST.has(first) || (first === 'START' && second === 'TRANSACTION') || (first === 'SET' && second === 'TRANSACTION')) {
    return {
      class: 'write',
      kind: first,
      reasons: [],
      blocked: 'transaction control is not available — every studio run is its own transaction',
    };
  }

  if (DDL_FIRST.has(first)) {
    cls = 'destructive';
    kind = ['CREATE', 'ALTER', 'DROP'].includes(first) && second ? `${first} ${w[1] === 'OR' ? w.slice(1, 4).join(' ') : second}` : first;
    reasons.push(first === 'TRUNCATE' ? 'TRUNCATE removes every row' : 'schema change (DDL)');
  } else if (ADMIN_FIRST.has(first)) {
    cls = 'destructive';
    reasons.push('server administration');
  } else if (WRITE_FIRST.has(first)) {
    cls = 'write';
    if (first === 'COPY') {
      const to = w.includes('TO');
      if (w.includes('PROGRAM')) return { class: 'destructive', kind: 'COPY', reasons: [], blocked: 'COPY … PROGRAM runs a shell command on the database host' };
      const std = w.includes('STDOUT') || w.includes('STDIN');
      if (!std) return { class: 'destructive', kind: 'COPY', reasons: [], blocked: 'COPY to or from a server file is not available in the studio' };
      if (to) cls = 'read';
    }
    if (first === 'LOAD') {
      return { class: 'destructive', kind: 'LOAD', reasons: [], blocked: 'LOAD DATA / LOAD XML read files and are not available in the studio' };
    }
    if (first === 'DO' || first === 'CALL') {
      cls = 'destructive';
      reasons.push(first === 'DO' ? 'anonymous code block runs arbitrary statements' : 'a procedure may run arbitrary statements');
    }
    if (first === 'VACUUM' && w.includes('FULL')) {
      cls = 'destructive';
      reasons.push('VACUUM FULL rewrites and locks the table');
    }
    if (cls === 'write' && first !== 'COPY') reasons.push(`${first} changes data`);
  } else if (READ_FIRST.has(first)) {
    if (first === 'SET') {
      if (['GLOBAL', 'PERSIST', 'PERSIST_ONLY'].includes(second) || tokens.some((t) => t.kind === 'punct' && t.value === '@') && (w.includes('GLOBAL') || w.includes('PERSIST') || w.includes('PERSIST_ONLY'))) {
        cls = 'destructive';
        reasons.push('SET GLOBAL changes the whole server');
      } else {
        const why = dialect === 'mysql' ? mysqlSetWrite(tokens) : pgSetWrite(w);
        if (why) {
          cls = up(cls, 'write');
          reasons.push(why);
        }
      }
    }
    if (first === 'EXPLAIN' && w.includes('ANALYZE')) {
      // EXPLAIN ANALYZE executes the statement: classify what it runs.
      const at = tokens.findIndex((t) => t.kind === 'word' && ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'MERGE', 'WITH', 'VALUES', 'TABLE'].includes(t.value) && t.depth === 0);
      if (at > 0) {
        const inner = classifySqlStatement(tokens.slice(at).map((t) => ({ ...t })), dialect);
        cls = up(cls, inner.class);
        reasons.push(...inner.reasons.map((r) => `EXPLAIN ANALYZE runs it: ${r}`));
      }
    }
  } else {
    cls = 'destructive';
    reasons.push(`unrecognised statement (${first})`);
  }

  // DML hiding in CTEs / subqueries (`WITH d AS (DELETE …) SELECT …`).
  for (let k = 1; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== 'word' || !DML_ANYWHERE.has(t.value)) continue;
    const prev = tokens[k - 1];
    // `FOR UPDATE`, `ON UPDATE CASCADE`, `ON DELETE …`, `ON CONFLICT DO UPDATE`,
    // `ON DUPLICATE KEY UPDATE`, `WHEN MATCHED THEN UPDATE/DELETE` are clauses, not statements.
    const clause = prev?.kind === 'word' && ['FOR', 'ON', 'DO', 'KEY', 'THEN', 'NO'].includes(prev.value);
    if (t.value === 'UPDATE' && prev?.kind === 'word' && prev.value === 'FOR') {
      cls = up(cls, 'write');
      reasons.push('FOR UPDATE locks rows');
      continue;
    }
    if (clause) continue;
    if (k > 0 && ['INSERT', 'UPDATE', 'DELETE', 'MERGE'].includes(t.value)) {
      if (cls === 'read') {
        cls = 'write';
        reasons.push(`contains ${t.value} (a data-modifying CTE or subquery)`);
      }
    } else if (['TRUNCATE', 'DROP', 'ALTER', 'CREATE', 'GRANT', 'REVOKE'].includes(t.value) && t.depth > 0) {
      cls = 'destructive';
      reasons.push(`contains ${t.value}`);
    }
  }

  // DELETE / UPDATE without a WHERE — at the top level or inside a CTE.
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k]!;
    if (t.kind !== 'word' || (t.value !== 'DELETE' && t.value !== 'UPDATE')) continue;
    const prev = tokens[k - 1];
    if (prev?.kind === 'word' && ['FOR', 'ON', 'DO', 'KEY', 'THEN', 'NO'].includes(prev.value)) continue;
    if (t.value === 'UPDATE' && dialect === 'mysql' && prev?.kind === 'word' && prev.value === 'DUPLICATE') continue;
    const wh = whereFor(tokens, k);
    if (wh === 'none') {
      cls = 'destructive';
      reasons.push(`${t.value} without WHERE touches every row`);
    } else if (wh === 'trivial') {
      cls = 'destructive';
      reasons.push(`${t.value} with an always-true WHERE touches every row`);
    }
  }

  // SELECT … INTO: a new table (Postgres) or a server file (MySQL OUTFILE/DUMPFILE).
  if (first === 'SELECT' || first === 'WITH') {
    const into = tokens.findIndex((t) => t.kind === 'word' && t.value === 'INTO' && t.depth === 0);
    if (into > 0) {
      const after = tokens[into + 1];
      if (after?.kind === 'word' && (after.value === 'OUTFILE' || after.value === 'DUMPFILE')) {
        return { class: 'destructive', kind: 'SELECT INTO OUTFILE', reasons: [], blocked: 'SELECT … INTO OUTFILE writes a file on the database host' };
      }
      const isVar = after?.kind === 'punct' && after.value === '@';
      if (!isVar && !w.includes('INSERT')) {
        cls = 'destructive';
        reasons.push('SELECT … INTO creates a table');
      }
    }
  }

  // Side-effecting functions (`SELECT pg_terminate_backend(…)`).
  for (let k = 0; k < tokens.length - 1; k++) {
    const t = tokens[k]!;
    const nx = tokens[k + 1]!;
    const fn = dangerousCall(t);
    if (fn && nx.kind === 'punct' && nx.value === '(') {
      cls = 'destructive';
      reasons.push(`${fn.toLowerCase()}() acts outside the transaction`);
    }
  }

  return { class: cls, kind, reasons: [...new Set(reasons)] };
}

/** Classify a SQL input. Several statements chained with `;` are blocked. */
export function classifySql(sql: string, dialect: SqlDialect): Classification {
  const lexed = lexSql(sql, dialect);
  if (lexed.error) return { class: 'destructive', kind: '?', reasons: [], blocked: `could not read the statement: ${lexed.error}` };
  if (lexed.statements.length === 0) return { class: 'read', kind: '', reasons: [], blocked: 'empty statement' };
  const parts = lexed.statements.map((s) => classifySqlStatement(s.tokens, dialect));
  if (parts.length > 1) {
    const worst = parts.reduce<StatementClass>((a, p) => up(a, p.class), 'read');
    return {
      class: worst,
      kind: parts.map((p) => p.kind).join('; '),
      reasons: parts.flatMap((p) => p.reasons),
      blocked: `${parts.length} statements — run one statement at a time`,
    };
  }
  return parts[0]!;
}

/** The single statement text without its trailing `;` (what the agent runs). */
export function singleStatementText(sql: string, dialect: SqlDialect): string | null {
  const lexed = lexSql(sql, dialect);
  if (lexed.error || lexed.statements.length !== 1) return null;
  return lexed.statements[0]!.text;
}

// ── Mongo ────────────────────────────────────────────────────────────────────

const MONGO_READ = new Set([
  'find', 'aggregate', 'count', 'distinct', 'listcollections', 'listindexes', 'listdatabases', 'dbstats',
  'collstats', 'serverstatus', 'buildinfo', 'hello', 'ismaster', 'ping', 'explain', 'currentop',
  'validate', 'datasize', 'hostinfo', 'connectionstatus', 'getcmdlineopts', 'top', 'getlog',
]);
const MONGO_WRITE = new Set(['insert', 'update', 'delete', 'findandmodify', 'bulkwrite']);
const MONGO_DDL = new Set([
  'create', 'createindexes', 'drop', 'dropdatabase', 'dropindexes', 'renamecollection', 'collmod',
  'converttocapped', 'emptycapped', 'compact', 'clonecollectionascapped', 'createview',
]);

function isEmptyFilter(f: unknown): boolean {
  return f == null || (typeof f === 'object' && !Array.isArray(f) && Object.keys(f as object).length === 0);
}

/** First key of a command document = the command name (Mongo's own rule). */
export function mongoCommandName(doc: Record<string, unknown>): string {
  return Object.keys(doc)[0] ?? '';
}

export function classifyMongo(doc: unknown): Classification {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { class: 'destructive', kind: '?', reasons: [], blocked: 'a Mongo command must be a JSON document' };
  }
  const d = doc as Record<string, unknown>;
  const name = mongoCommandName(d);
  const key = name.toLowerCase();
  if (!name) return { class: 'read', kind: '', reasons: [], blocked: 'empty command' };
  if (key === 'getmore' || key === 'killcursors') {
    return { class: 'read', kind: name, reasons: [], blocked: 'cursors are not kept between studio runs' };
  }
  if (['eval', '$eval', 'shutdown', 'fsync', 'setparameter', 'createuser', 'updateuser', 'dropuser', 'grantrolestouser', 'revokerolesfromuser', 'dropallusersfromdatabase', 'createrole', 'droprole', 'replsetreconfig', 'replsetstepdown', 'killop', 'logout', 'authenticate', 'saslstart', 'saslcontinue', 'copydb', 'applyops'].includes(key)) {
    return { class: 'destructive', kind: name, reasons: ['server administration'], ...(key === 'authenticate' || key.startsWith('sasl') ? { blocked: 'authentication commands are not available' } : {}) };
  }
  if (MONGO_READ.has(key)) {
    if (key === 'aggregate') {
      const pipe = Array.isArray(d.pipeline) ? d.pipeline : [];
      const out = pipe.find((s) => s && typeof s === 'object' && ('$out' in (s as object) || '$merge' in (s as object)));
      if (out) return { class: 'write', kind: 'aggregate', reasons: ['$out / $merge writes a collection'] };
    }
    if (key === 'explain') {
      const inner = classifyMongo(d.explain);
      return { class: inner.class === 'read' ? 'read' : 'read', kind: `explain ${inner.kind}`, reasons: [] };
    }
    return { class: 'read', kind: name, reasons: [] };
  }
  if (key === 'profile') {
    return d.profile === -1
      ? { class: 'read', kind: 'profile', reasons: [] }
      : { class: 'write', kind: 'profile', reasons: ['changes the profiler level'] };
  }
  if (key === 'mapreduce') {
    const out = d.out;
    const inline = out && typeof out === 'object' && 'inline' in (out as object);
    return inline ? { class: 'read', kind: name, reasons: [] } : { class: 'write', kind: name, reasons: ['mapReduce writes a collection'] };
  }
  if (MONGO_DDL.has(key)) {
    return { class: 'destructive', kind: name, reasons: [key.startsWith('drop') ? `${name} deletes data` : 'schema change (DDL)'] };
  }
  if (MONGO_WRITE.has(key)) {
    const reasons: string[] = [`${name} changes data`];
    let cls: StatementClass = 'write';
    if (key === 'delete') {
      const dels = Array.isArray(d.deletes) ? d.deletes : [];
      if (dels.length === 0 || dels.some((x) => isEmptyFilter((x as { q?: unknown })?.q))) {
        cls = 'destructive';
        reasons.push('delete with an empty filter removes every document');
      }
    }
    if (key === 'update') {
      const ups = Array.isArray(d.updates) ? d.updates : [];
      if (ups.some((x) => isEmptyFilter((x as { q?: unknown })?.q) && (x as { multi?: unknown })?.multi === true)) {
        cls = 'destructive';
        reasons.push('update with an empty filter and multi touches every document');
      }
    }
    if (key === 'findandmodify' && d.remove === true && isEmptyFilter(d.query)) reasons.push('removes the first document');
    return { class: cls, kind: name, reasons };
  }
  return { class: 'destructive', kind: name, reasons: [`unrecognised command (${name})`] };
}

// ── Redis / Valkey ───────────────────────────────────────────────────────────

const REDIS_READ = new Set([
  'GET', 'MGET', 'GETRANGE', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'HSTRLEN', 'HSCAN', 'HRANDFIELD',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS', 'SMEMBERS', 'SCARD', 'SISMEMBER', 'SMISMEMBER', 'SSCAN', 'SRANDMEMBER',
  'SINTER', 'SUNION', 'SDIFF', 'SINTERCARD', 'ZRANGE', 'ZRANGEBYSCORE', 'ZREVRANGE', 'ZREVRANGEBYSCORE',
  'ZRANGEBYLEX', 'ZCARD', 'ZSCORE', 'ZMSCORE', 'ZRANK', 'ZREVRANK', 'ZCOUNT', 'ZLEXCOUNT', 'ZSCAN', 'ZRANDMEMBER',
  'XRANGE', 'XREVRANGE', 'XLEN', 'XINFO', 'XPENDING', 'SCAN', 'DBSIZE', 'INFO', 'PING', 'ECHO', 'TIME',
  'RANDOMKEY', 'OBJECT', 'MEMORY', 'SLOWLOG', 'LATENCY', 'BITCOUNT', 'BITPOS', 'GETBIT', 'PFCOUNT',
  'GEOPOS', 'GEODIST', 'GEOHASH', 'GEOSEARCH', 'GEORADIUS_RO', 'GEORADIUSBYMEMBER_RO', 'DUMP', 'LCS',
  'SUBSTR', 'COMMAND', 'LOLWUT', 'ROLE', 'LASTSAVE', 'KEYS', 'JSON.GET', 'JSON.TYPE', 'JSON.STRLEN', 'JSON.OBJKEYS',
]);
const REDIS_DESTRUCTIVE = new Set([
  'FLUSHALL', 'FLUSHDB', 'SHUTDOWN', 'DEBUG', 'SWAPDB', 'MIGRATE', 'REPLICAOF', 'SLAVEOF', 'MODULE',
  'FAILOVER', 'CLUSTER', 'SAVE', 'BGSAVE', 'BGREWRITEAOF', 'EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO',
  'FCALL', 'FCALL_RO', 'FUNCTION', 'SCRIPT',
]);
const REDIS_BLOCKED: Record<string, string> = {
  AUTH: 'authentication commands are not available',
  HELLO: 'connection commands are not available',
  ACL: 'ACL commands are not available in the studio',
  CONFIG: 'CONFIG can reveal credentials — use Insights for server settings',
  MONITOR: 'streaming commands are not available',
  SUBSCRIBE: 'streaming commands are not available',
  PSUBSCRIBE: 'streaming commands are not available',
  SSUBSCRIBE: 'streaming commands are not available',
  SYNC: 'replication commands are not available',
  PSYNC: 'replication commands are not available',
  SELECT: 'pick the database with the db selector instead of SELECT',
  MULTI: 'transactions are not available — every studio run is one command',
  EXEC: 'transactions are not available — every studio run is one command',
  WATCH: 'transactions are not available — every studio run is one command',
  CLIENT: 'CLIENT commands are not available in the studio',
  QUIT: 'connection commands are not available',
  RESET: 'connection commands are not available',
};

export function classifyRedis(argv: string[]): Classification {
  const cmd = (argv[0] ?? '').toUpperCase();
  if (!cmd) return { class: 'read', kind: '', reasons: [], blocked: 'empty command' };
  const sub = (argv[1] ?? '').toUpperCase();
  const kind = ['OBJECT', 'MEMORY', 'SLOWLOG', 'XINFO', 'LATENCY', 'COMMAND', 'FUNCTION', 'SCRIPT', 'CLUSTER'].includes(cmd) && sub ? `${cmd} ${sub}` : cmd;
  if (REDIS_BLOCKED[cmd]) return { class: 'destructive', kind, reasons: [], blocked: REDIS_BLOCKED[cmd] };
  if (cmd === 'SLOWLOG' && sub === 'RESET') return { class: 'destructive', kind, reasons: ['clears the slow log'] };
  if (cmd === 'LATENCY' && sub === 'RESET') return { class: 'destructive', kind, reasons: ['clears latency history'] };
  if (cmd === 'MEMORY' && (sub === 'PURGE' || sub === 'DOCTOR')) return { class: 'write', kind, reasons: ['memory maintenance'] };
  if (cmd === 'SORT' || cmd === 'SORT_RO') {
    return argv.some((a) => a.toUpperCase() === 'STORE')
      ? { class: 'write', kind, reasons: ['SORT … STORE writes a key'] }
      : { class: 'read', kind, reasons: [] };
  }
  if (cmd === 'KEYS') return { class: 'read', kind, reasons: ['KEYS blocks the server on large keyspaces — prefer SCAN'] };
  if (REDIS_READ.has(cmd)) return { class: 'read', kind, reasons: [] };
  if (REDIS_DESTRUCTIVE.has(cmd)) {
    const why = cmd.startsWith('FLUSH') ? 'removes every key' : cmd.startsWith('EVAL') || cmd.startsWith('FCALL') ? 'a script may run any command' : 'server administration';
    return { class: 'destructive', kind, reasons: [why] };
  }
  if (/^[A-Z][A-Z._]*$/.test(cmd)) return { class: 'write', kind, reasons: [`${cmd} changes data`] };
  return { class: 'destructive', kind, reasons: [`unrecognised command (${cmd})`] };
}

/** The agent-side allowlist for `access: read` (second wall behind the classifier). */
export function redisReadAllowed(argv: string[]): boolean {
  const c = classifyRedis(argv);
  return c.class === 'read' && !c.blocked;
}

export function mongoReadAllowed(doc: unknown): boolean {
  const c = classifyMongo(doc);
  return c.class === 'read' && !c.blocked;
}
