/**
 * The one ClickHouse HTTP client swarmy uses (observability reads, error
 * tracking, RUM, the email send log, the workers). The controller is the only
 * reader/writer. DSN form: `http://user:password@host:8123/database`.
 *
 * `exec` / `json` / `insert` THROW on a non-2xx or a network error; callers
 * that fail open (a read that should render "unreachable") catch.
 */
export interface ClickhouseClient {
  readonly database: string;
  exec(sql: string): Promise<void>;
  json<T>(sql: string): Promise<T[]>;
  /** JSONEachRow insert: row objects, or an already-serialized NDJSON body. */
  insert(table: string, rows: readonly object[] | string): Promise<void>;
  ping(): Promise<boolean>;
}

export interface ClickhouseTarget {
  baseUrl: string;
  user: string;
  password: string;
  database: string;
}

/** Rows saved before the store was renamed carry this bare host, which never resolves on the overlay. */
const LEGACY_CLICKHOUSE_HOST = 'clickhouse';
const CLICKHOUSE_SERVICE_HOST = 'swarmy-clickhouse';

export function parseClickhouseDsn(dsn: string): ClickhouseTarget {
  const u = new URL(dsn);
  if (u.hostname === LEGACY_CLICKHOUSE_HOST) u.hostname = CLICKHOUSE_SERVICE_HOST;
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || 'otel',
  };
}

export interface ClickhouseClientOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout (default 15s). */
  timeoutMs?: number;
  /** Return 64-bit integers as JSON numbers instead of ClickHouse's default quoted strings. */
  unquote64BitInts?: boolean;
}

const TABLE_RE = /^[A-Za-z_][A-Za-z0-9_.]*$/;

export function clickhouseClient(target: ClickhouseTarget | string, opts: ClickhouseClientOptions = {}): ClickhouseClient {
  const t = typeof target === 'string' ? parseClickhouseDsn(target) : target;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const headers = { 'X-ClickHouse-User': t.user, 'X-ClickHouse-Key': t.password, 'Content-Type': 'text/plain' };
  const url = (extra: Record<string, string> = {}) => {
    const u = new URL(t.baseUrl);
    u.searchParams.set('database', t.database);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  };
  async function post(body: string, extra?: Record<string, string>): Promise<string> {
    const res = await fetchImpl(url(extra), { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }
  return {
    database: t.database,
    async exec(sql) {
      await post(sql);
    },
    async json<T>(sql: string) {
      const text = await post(sql, {
        default_format: 'JSONEachRow',
        ...(opts.unquote64BitInts ? { output_format_json_quote_64bit_integers: '0' } : {}),
      });
      if (!text.trim()) return [];
      return text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as T);
    },
    async insert(table, rows) {
      if (!TABLE_RE.test(table)) throw new Error(`invalid table ${table}`);
      const body = typeof rows === 'string' ? rows : rows.map((r) => JSON.stringify(r)).join('\n');
      if (!body) return;
      await post(body, { query: `INSERT INTO ${table} FORMAT JSONEachRow`, date_time_input_format: 'best_effort' });
    },
    async ping() {
      try {
        const res = await fetchImpl(`${t.baseUrl}/ping`, { signal: AbortSignal.timeout(3000) });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
