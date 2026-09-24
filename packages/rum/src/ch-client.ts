/**
 * Minimal ClickHouse HTTP client (the controller is the only reader/writer).
 * DSN form: http://user:password@host:8123/database
 */
export interface ClickhouseClient {
  exec(sql: string): Promise<void>;
  json<T>(sql: string): Promise<T[]>;
  insert(table: string, rows: readonly object[]): Promise<void>;
  ping(): Promise<boolean>;
}

export interface ClickhouseTarget {
  baseUrl: string;
  user: string;
  password: string;
  database: string;
}

export function parseClickhouseDsn(dsn: string): ClickhouseTarget {
  const u = new URL(dsn);
  return {
    baseUrl: `${u.protocol}//${u.host}`,
    user: decodeURIComponent(u.username || 'default'),
    password: decodeURIComponent(u.password || ''),
    database: u.pathname.replace(/^\//, '') || 'otel',
  };
}

export function clickhouseClient(t: ClickhouseTarget, fetchImpl: typeof fetch = fetch): ClickhouseClient {
  const headers = { 'X-ClickHouse-User': t.user, 'X-ClickHouse-Key': t.password, 'Content-Type': 'text/plain' };
  const url = (extra: Record<string, string> = {}) => {
    const u = new URL(t.baseUrl);
    u.searchParams.set('database', t.database);
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
    return u.toString();
  };
  async function post(body: string, extra?: Record<string, string>): Promise<string> {
    const res = await fetchImpl(url(extra), { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`clickhouse ${res.status}: ${text.slice(0, 300)}`);
    return text;
  }
  return {
    async exec(sql) {
      await post(sql);
    },
    async json<T>(sql: string) {
      const text = await post(sql, { default_format: 'JSONEachRow', output_format_json_quote_64bit_integers: '0' });
      if (!text.trim()) return [];
      return text
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as T);
    },
    async insert(table, rows) {
      if (rows.length === 0) return;
      const body = rows.map((r) => JSON.stringify(r)).join('\n');
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
