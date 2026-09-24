/**
 * The in-task scripts the agent exec's for a `dbQuery`, and the parsers for
 * what the engine clients print. Pure and golden-tested; the agent only runs
 * `sh -c <script>` inside the DB task with the env below and parses stdout.
 *
 * Env contract (set by the agent on the exec, never argv):
 *   SWARMY_Q          the statement / EJSON command document
 *   SWARMY_Q_DB       database to run in (optional)
 *   SWARMY_ACCESS     read | write
 *   SWARMY_TIMEOUT_MS statement timeout
 *   SWARMY_MAX_BYTES  stdout byte cap (the script stops reading after it)
 *   SWARMY_ROW_CAP    Mongo only: documents kept
 *   SWARMY_NULL       Postgres only: the per-run NULL sentinel
 *   SWARMY_JS         Mongo only: {@link MONGO_STUDIO_JS}
 *   SWARMY_REDIS_ARGPW / SWARMY_REDIS_CONF  Redis `--requirepass` hints (as the dump probe)
 * Redis argv rides as positional parameters ("$@").
 *
 * Credentials are resolved INSIDE the task by {@link credAssignScript} (the
 * dump path's recipe) and handed to the client as libpq env / a /dev/shm option
 * file / REDISCLI_AUTH — never printed, never on argv.
 */
import { credAssignScript } from '../protocol/appDbScripts';
import type { AppDbCreds } from '../protocol/appDb';
import type { StudioEngine } from '../protocol/studio';
import { parseRedisNoRaw, type RedisReply } from './redis';

/** Outer kill: the engine's own timeout first, then this (+10s) if the client wedges. */
const KILLER = 'K=""; if command -v timeout >/dev/null 2>&1; then K="timeout -s KILL $(( ${SWARMY_TIMEOUT_MS:-15000} / 1000 + 10 ))"; fi';
/** stdout is cut at the byte cap (+1 so the agent can tell it was cut); the client's exit code rides stderr. */
const CAP = 'head -c "$(( ${SWARMY_MAX_BYTES:-524288} + 1 ))"';

const PG_SCRIPT = [
  'set -u',
  'command -v psql >/dev/null 2>&1 || { echo "swarmy: no psql in this image" >&2; exit 3; }',
  'export PGHOST=127.0.0.1 PGPORT="${SWARMY_DB_PORT:-5432}" PGUSER="${SWARMY_DB_USER:-postgres}" PGPASSWORD="${SWARMY_DB_PASSWORD:-}"',
  'export PGDATABASE="${SWARMY_Q_DB:-${SWARMY_DB_NAME:-postgres}}" PGCONNECT_TIMEOUT=5 PGAPPNAME=swarmy-studio',
  'T=${SWARMY_TIMEOUT_MS:-15000}',
  'if [ "${SWARMY_ACCESS:-read}" = write ]; then',
  '  export PGOPTIONS="-c statement_timeout=$T -c lock_timeout=$T"',
  '  set -- -c "$SWARMY_Q"',
  'else',
  // Read-only session default AND an explicit read-only transaction whose
  // snapshot is taken before the statement runs (so `SET transaction_read_only
  // = off` inside it is refused by the server).
  '  export PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=$T -c lock_timeout=$T -c idle_in_transaction_session_timeout=$((T + 5000))"',
  "  set -- -q -c 'BEGIN READ ONLY' -c 'SELECT 1 AS swarmy_snapshot' -c \"$SWARMY_Q\" -c 'ROLLBACK'",
  'fi',
  KILLER,
  `( $K psql -X --no-psqlrc -v ON_ERROR_STOP=1 --csv -P "null=\${SWARMY_NULL:-}" "$@"; echo "SWARMY_RC=$?" >&2 ) | ${CAP}`,
].join('\n');

const MYSQL_SCRIPT = [
  'set -u',
  'CLI=$(command -v mariadb || command -v mysql || true)',
  '[ -n "$CLI" ] || { echo "swarmy: no mysql/mariadb client in this image" >&2; exit 3; }',
  '{ [ -d /dev/shm ] && [ -w /dev/shm ]; } || { echo "swarmy: /dev/shm is not writable — refusing to put credentials on disk" >&2; exit 3; }',
  'umask 077',
  'CNF=/dev/shm/swarmy-studio-$$.cnf',
  "trap 'rm -f \"$CNF\"' EXIT",
  String.raw`esc() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }`,
  "{ echo '[client]'; printf 'user=\"%s\"\\n' \"$(esc \"${SWARMY_DB_USER:-root}\")\"; " +
    "printf 'password=\"%s\"\\n' \"$(esc \"${SWARMY_DB_PASSWORD:-}\")\"; " +
    "echo 'host=127.0.0.1'; printf 'port=%s\\n' \"${SWARMY_DB_PORT:-3306}\"; echo 'connect-timeout=5'; } > \"$CNF\"",
  'T=${SWARMY_TIMEOUT_MS:-15000}',
  'DB="${SWARMY_Q_DB:-${SWARMY_DB_NAME:-}}"',
  // --binary-mode disables client commands (`system`, `\\!`) in batch mode.
  'set -- --defaults-extra-file="$CNF" --xml --quick --binary-mode --show-warnings',
  "if \"$CLI\" --help 2>/dev/null | grep -q -- '--binary-as-hex'; then set -- \"$@\" --binary-as-hex; fi",
  '[ -z "$DB" ] || set -- "$@" -D "$DB"',
  'V=$("$CLI" --defaults-extra-file="$CNF" -N -B -e "SELECT VERSION()" 2>/dev/null || true)',
  'case "$V" in *MariaDB*) TO="SET SESSION max_statement_time=$(( (T + 999) / 1000 ))";; *) TO="SET SESSION max_execution_time=$T";; esac',
  'LW="SET SESSION innodb_lock_wait_timeout=$(( (T + 999) / 1000 )); SET SESSION lock_wait_timeout=$(( (T + 999) / 1000 ))"',
  'if [ "${SWARMY_ACCESS:-read}" = write ]; then',
  "  Q=$(printf '%s; %s;\\n%s\\n;\\nSELECT ROW_COUNT() AS swarmy_affected' \"$TO\" \"$LW\" \"$SWARMY_Q\")",
  'else',
  "  Q=$(printf '%s; %s; SET SESSION TRANSACTION READ ONLY; START TRANSACTION READ ONLY;\\n%s\\n;\\nROLLBACK' \"$TO\" \"$LW\" \"$SWARMY_Q\")",
  'fi',
  KILLER,
  `( $K "$CLI" "$@" -e "$Q"; echo "SWARMY_RC=$?" >&2 ) | ${CAP}`,
].join('\n');

/**
 * mongosh script (read from SWARMY_JS). Authenticates in-script from env (no
 * password on argv), runs ONE command document, caps documents + bytes, kills
 * any open cursor. Prints a single `SWARMY_JSON ` line.
 */
export const MONGO_STUDIO_JS = [
  'const e = process.env;',
  "if (e.SWARMY_DB_USER) { db.getSiblingDB(e.SWARMY_DB_AUTHDB || 'admin').auth(e.SWARMY_DB_USER, e.SWARMY_DB_PASSWORD || ''); }",
  "const target = db.getSiblingDB(e.SWARMY_Q_DB || e.SWARMY_DB_NAME || 'test');",
  'const cap = Number(e.SWARMY_ROW_CAP || 1000), max = Number(e.SWARMY_MAX_BYTES || 524288);',
  'let out;',
  'try {',
  '  const cmd = EJSON.parse(e.SWARMY_Q);',
  '  const r = target.runCommand(cmd);',
  '  let docs = null;',
  '  if (r && r.cursor && Array.isArray(r.cursor.firstBatch)) { docs = r.cursor.firstBatch; r.cursor.firstBatch = undefined; }',
  '  else if (r && Array.isArray(r.values)) { docs = r.values.map((v) => ({ value: v })); r.values = undefined; }',
  '  const kept = []; let bytes = 0; let truncated = false;',
  '  if (docs) { for (const d of docs) { if (kept.length >= cap) { truncated = true; break; } const s = EJSON.stringify(d, { relaxed: true }); bytes += s.length; if (bytes > max) { truncated = true; break; } kept.push(s); } }',
  "  if (r && r.cursor && r.cursor.id && String(r.cursor.id) !== '0') {",
  '    truncated = true;',
  "    try { target.runCommand({ killCursors: String(r.cursor.ns).split('.').slice(1).join('.'), cursors: [r.cursor.id] }); } catch (_) {}",
  '  }',
  '  out = { ok: true, reply: EJSON.stringify(r, { relaxed: true }), docs: docs ? kept : null, truncated };',
  '} catch (err) {',
  '  out = { ok: false, error: String((err && err.message) || err), code: err && err.code };',
  '}',
  "print('SWARMY_JSON ' + JSON.stringify(out));",
].join('\n');

const MONGO_SCRIPT = [
  'set -u',
  'SH=$(command -v mongosh || true)',
  '[ -n "$SH" ] || { echo "swarmy: no mongosh in this image (the official mongo image ships it from 5.0)" >&2; exit 3; }',
  // mongosh reads them from process.env and authenticates in-script (no password on argv).
  'export SWARMY_DB_USER SWARMY_DB_PASSWORD SWARMY_DB_NAME SWARMY_DB_AUTHDB',
  KILLER,
  `( $K "$SH" --quiet --norc --host 127.0.0.1 --port "\${SWARMY_DB_PORT:-27017}" --eval "$SWARMY_JS"; echo "SWARMY_RC=$?" >&2 ) | ${CAP}`,
].join('\n');

const REDIS_SCRIPT = [
  'set -u',
  'CLI=$(command -v valkey-cli || command -v redis-cli || true)',
  '[ -n "$CLI" ] || { echo "swarmy: no redis-cli/valkey-cli in this image" >&2; exit 3; }',
  '[ -z "${SWARMY_DB_PASSWORD:-}" ] || export REDISCLI_AUTH="$SWARMY_DB_PASSWORD"',
  KILLER,
  `( $K "$CLI" --no-raw -h 127.0.0.1 -p "\${SWARMY_DB_PORT:-6379}" -n "\${SWARMY_Q_DBINDEX:-0}" "$@"; echo "SWARMY_RC=$?" >&2 ) | ${CAP}`,
].join('\n');

/** The whole `sh -c` script for one studio run: in-task credential resolution + the engine client. */
export function studioScript(engine: StudioEngine, creds: AppDbCreds): string {
  const body =
    engine === 'postgres'
      ? PG_SCRIPT
      : engine === 'mysql' || engine === 'mariadb'
        ? MYSQL_SCRIPT
        : engine === 'mongo'
          ? MONGO_SCRIPT
          : REDIS_SCRIPT;
  return [credAssignScript(creds), body].join('\n');
}

// ── output parsing ───────────────────────────────────────────────────────────

/** The client's exit code (the script echoes it on stderr), and stderr without that line. */
export function splitStderr(stderr: string): { rc: number | null; text: string } {
  let rc: number | null = null;
  const keep: string[] = [];
  for (const line of stderr.split('\n')) {
    const m = /^SWARMY_RC=(\d+)$/.exec(line.trim());
    if (m) rc = Number(m[1]);
    else if (line.trim()) keep.push(line);
  }
  return { rc, text: keep.join('\n') };
}

/** RFC 4180 CSV (psql `--csv`): quoted fields may hold commas, quotes, newlines. */
export function parseCsv(text: string): { rows: string[][]; complete: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let inQuotes = false;
  let i = 0;
  let started = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      inQuotes = true;
      quoted = true;
      started = true;
      i++;
      continue;
    }
    if (c === ',') {
      row.push(quoted ? `\u0001${field}` : field);
      field = '';
      quoted = false;
      i++;
      continue;
    }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(quoted ? `\u0001${field}` : field);
      rows.push(row);
      row = [];
      field = '';
      quoted = false;
      started = false;
      i++;
      continue;
    }
    field += c;
    started = true;
    i++;
  }
  const complete = !inQuotes && !started && row.length === 0;
  if (!complete && !inQuotes) {
    row.push(quoted ? `\u0001${field}` : field);
    rows.push(row);
  }
  return { rows, complete: complete || (!inQuotes && text.endsWith('\n')) };
}

export interface SqlParsed {
  columns: string[];
  rows: Array<Array<string | null>>;
  truncated: boolean;
  status?: string;
  affected?: number;
}

const PG_TAG = /^(INSERT \d+ \d+|UPDATE \d+|DELETE \d+|MERGE \d+|SELECT \d+|COPY \d+|MOVE \d+|FETCH \d+|[A-Z][A-Z ]*[A-Z])$/;

/**
 * psql `--csv` output of ONE statement. A write may end with its command tag
 * (`UPDATE 3`); a read starts with the snapshot probe's `swarmy_snapshot,1`.
 * NULL is the per-run sentinel; a quoted empty field is the empty string.
 */
export function parsePsqlOutput(stdout: string, nullSentinel: string, opts: { rowCap: number; maxBytes: number; access: 'read' | 'write' }): SqlParsed {
  let text = stdout;
  let truncated = false;
  if (Buffer.byteLength(text, 'utf8') > opts.maxBytes) {
    truncated = true;
    text = Buffer.from(text, 'utf8').subarray(0, opts.maxBytes).toString('utf8');
  }
  if (opts.access === 'read' && text.startsWith('swarmy_snapshot\n1\n')) text = text.slice('swarmy_snapshot\n1\n'.length);
  const { rows: all, complete } = parseCsv(text);
  let lines = all;
  if (!complete) {
    truncated = true;
    lines = lines.slice(0, -1); // the cut row is partial
  }
  let status: string | undefined;
  let affected: number | undefined;
  const last = lines[lines.length - 1];
  if (opts.access === 'write' && last && last.length === 1 && PG_TAG.test(last[0]!)) {
    status = last[0]!;
    lines = lines.slice(0, -1);
    const n = /(\d+)$/.exec(status);
    if (n && /^(INSERT|UPDATE|DELETE|MERGE|COPY)/.test(status)) affected = Number(n[1]);
  }
  const unq = (f: string) => (f.startsWith('\u0001') ? f.slice(1) : f);
  if (lines.length === 0) return { columns: [], rows: [], truncated, ...(status ? { status } : {}), ...(affected != null ? { affected } : {}) };
  const columns = lines[0]!.map(unq);
  let body = lines.slice(1).map((r) => r.map((f) => (f === nullSentinel ? null : unq(f))));
  if (body.length > opts.rowCap) {
    truncated = true;
    body = body.slice(0, opts.rowCap);
  }
  return { columns, rows: body, truncated, ...(status ? { status } : {}), ...(affected != null ? { affected } : {}) };
}

function xmlUnescape(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#(\d+)|#x([0-9a-fA-F]+));/g, (_m, name: string, dec?: string, hex?: string) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return ({ lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" } as Record<string, string>)[name] ?? '';
  });
}

/** `mysql --xml` → result sets (`<resultset>` → `<row>` → `<field name xsi:nil>`). */
export function parseMysqlXml(stdout: string): Array<{ columns: string[]; rows: Array<Array<string | null>>; complete: boolean }> {
  const sets: Array<{ columns: string[]; rows: Array<Array<string | null>>; complete: boolean }> = [];
  const setRe = /<resultset\b[^>]*>([\s\S]*?)(<\/resultset>|$)/g;
  let m: RegExpExecArray | null;
  while ((m = setRe.exec(stdout))) {
    const body = m[1]!;
    const complete = m[2] === '</resultset>';
    const columns: string[] = [];
    const rows: Array<Array<string | null>> = [];
    const rowRe = /<row>([\s\S]*?)<\/row>/g;
    let r: RegExpExecArray | null;
    while ((r = rowRe.exec(body))) {
      const fields: Array<[string, string | null]> = [];
      const fRe = /<field name="([^"]*)"(\s+xsi:nil="true"\s*\/>|>([\s\S]*?)<\/field>)/g;
      let f: RegExpExecArray | null;
      while ((f = fRe.exec(r[1]!))) {
        const name = xmlUnescape(f[1]!);
        fields.push([name, f[2]!.includes('xsi:nil') ? null : xmlUnescape(f[3] ?? '')]);
      }
      if (columns.length === 0) columns.push(...fields.map(([n]) => n));
      rows.push(fields.map(([, v]) => v));
    }
    sets.push({ columns, rows, complete });
    if (!complete) break;
  }
  return sets;
}

export function parseMysqlOutput(stdout: string, opts: { rowCap: number; maxBytes: number; access: 'read' | 'write' }): SqlParsed {
  let truncated = Buffer.byteLength(stdout, 'utf8') > opts.maxBytes;
  const sets = parseMysqlXml(truncated ? Buffer.from(stdout, 'utf8').subarray(0, opts.maxBytes).toString('utf8') : stdout);
  let affected: number | undefined;
  let data = sets;
  if (opts.access === 'write') {
    const last = sets[sets.length - 1];
    if (last && last.columns[0] === 'swarmy_affected') {
      const n = Number(last.rows[0]?.[0]);
      if (Number.isFinite(n) && n >= 0) affected = n;
      data = sets.slice(0, -1);
    }
  }
  const main = data[data.length - 1];
  if (!main) return { columns: [], rows: [], truncated, ...(affected != null ? { affected, status: `${affected} row${affected === 1 ? '' : 's'} affected` } : {}) };
  if (!main.complete) truncated = true;
  let rows = main.rows;
  if (rows.length > opts.rowCap) {
    truncated = true;
    rows = rows.slice(0, opts.rowCap);
  }
  return { columns: main.columns, rows, truncated, ...(affected != null ? { affected, status: `${affected} row${affected === 1 ? '' : 's'} affected` } : {}) };
}

export interface MongoParsed {
  ok: boolean;
  error?: string;
  reply: unknown;
  docs: unknown[] | null;
  truncated: boolean;
}

export function parseMongoOutput(stdout: string): MongoParsed {
  const line = stdout.split('\n').find((l) => l.startsWith('SWARMY_JSON '));
  if (!line) throw new Error('mongosh printed no result (output cut or the client failed)');
  const out = JSON.parse(line.slice('SWARMY_JSON '.length)) as { ok: boolean; reply?: string; docs?: string[] | null; truncated?: boolean; error?: string };
  if (!out.ok) return { ok: false, error: out.error ?? 'command failed', reply: null, docs: null, truncated: false };
  return {
    ok: true,
    reply: out.reply ? JSON.parse(out.reply) : null,
    docs: out.docs ? out.docs.map((d) => JSON.parse(d)) : null,
    truncated: Boolean(out.truncated),
  };
}

/** Top-level fields of documents in first-seen order, and cells (objects stay JSON). */
export function documentsToGrid(docs: unknown[]): { columns: string[]; rows: unknown[][] } {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    if (!d || typeof d !== 'object' || Array.isArray(d)) continue;
    for (const k of Object.keys(d)) if (!seen.has(k)) {
      seen.add(k);
      columns.push(k);
    }
  }
  const rows = docs.map((d) => columns.map((c) => (d && typeof d === 'object' ? ((d as Record<string, unknown>)[c] ?? null) : null)));
  return { columns, rows };
}

/** A Redis reply as a grid: arrays of pairs for HGETALL-like replies, else one value per row. */
export function redisReplyToGrid(argv: string[], reply: RedisReply): { columns: string[]; rows: unknown[][] } {
  const cmd = (argv[0] ?? '').toUpperCase();
  const pairs = (arr: RedisReply[], a: string, b: string) => {
    const rows: unknown[][] = [];
    for (let i = 0; i + 1 < arr.length; i += 2) rows.push([arr[i], arr[i + 1]]);
    return { columns: [a, b], rows };
  };
  if (Array.isArray(reply)) {
    if (cmd === 'HGETALL') return pairs(reply, 'field', 'value');
    if ((cmd === 'HSCAN' || cmd === 'ZSCAN') && Array.isArray(reply[1])) return pairs(reply[1] as RedisReply[], cmd === 'HSCAN' ? 'field' : 'member', cmd === 'HSCAN' ? 'value' : 'score');
    if ((cmd === 'SSCAN' || cmd === 'SCAN') && Array.isArray(reply[1])) return { columns: [cmd === 'SCAN' ? 'key' : 'member'], rows: (reply[1] as RedisReply[]).map((v) => [v]) };
    if (cmd.startsWith('ZRANGE') && argv.some((a) => a.toUpperCase() === 'WITHSCORES')) return pairs(reply, 'member', 'score');
    if (cmd === 'XRANGE' || cmd === 'XREVRANGE') {
      return {
        columns: ['id', 'fields'],
        rows: reply.map((e) => (Array.isArray(e) ? [e[0], Array.isArray(e[1]) ? Object.fromEntries(pairs(e[1] as RedisReply[], 'k', 'v').rows as Array<[string, unknown]>) : e[1]] : [e, null])),
      };
    }
    return { columns: ['#', 'value'], rows: reply.map((v, i) => [i + 1, v]) };
  }
  return { columns: ['value'], rows: [[reply]] };
}

export { parseRedisNoRaw };
