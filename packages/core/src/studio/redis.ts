/**
 * Redis/Valkey side of the studio: console tokenizing (redis-cli's own quoting
 * rules), the key browser's single bounded round trip, per-type value reads,
 * and the parser for `redis-cli --no-raw` replies (the one output format every
 * redis-cli / valkey-cli version shares).
 */

/** Split a console line the way redis-cli does: `"…"` (with escapes), `'…'` (literal), bare words. */
export function tokenizeRedis(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  const s = line.trim();
  while (i < s.length) {
    while (i < s.length && /\s/.test(s[i]!)) i++;
    if (i >= s.length) break;
    const c = s[i]!;
    let tok = '';
    if (c === '"') {
      i++;
      let closed = false;
      while (i < s.length) {
        const ch = s[i]!;
        if (ch === '\\') {
          const e = s[i + 1] ?? '';
          if (e === 'x' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 2, i + 4))) {
            tok += String.fromCharCode(parseInt(s.slice(i + 2, i + 4), 16));
            i += 4;
            continue;
          }
          tok += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e === 'b' ? '\b' : e === 'a' ? '\x07' : e;
          i += 2;
          continue;
        }
        if (ch === '"') {
          closed = true;
          i++;
          break;
        }
        tok += ch;
        i++;
      }
      if (!closed) throw new Error('unbalanced quotes');
    } else if (c === "'") {
      i++;
      let closed = false;
      while (i < s.length) {
        const ch = s[i]!;
        if (ch === '\\' && s[i + 1] === "'") {
          tok += "'";
          i += 2;
          continue;
        }
        if (ch === "'") {
          closed = true;
          i++;
          break;
        }
        tok += ch;
        i++;
      }
      if (!closed) throw new Error('unbalanced quotes');
    } else {
      while (i < s.length && !/\s/.test(s[i]!)) tok += s[i++];
    }
    out.push(tok);
  }
  return out;
}

/** Quote an argv element for display (the exact command the studio shows and audits). */
export function quoteRedisArg(a: string): string {
  if (a !== '' && /^[\x21-\x7e]+$/.test(a) && !/["'\\]/.test(a)) return a;
  return '"' + a.replace(/[\\"]/g, (m) => '\\' + m).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t') + '"';
}

export function redisCommandText(argv: string[]): string {
  return argv.map(quoteRedisArg).join(' ');
}

/**
 * One EVAL per browse page: SCAN a page, then TYPE / PTTL / size for each key,
 * server-side. It only ever READS; the agent accepts EVAL in read mode for this
 * exact script text and nothing else.
 */
export const REDIS_SCAN_LUA = [
  "local r = redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2], 'COUNT', ARGV[3])",
  'local out = { r[1] }',
  'for _, k in ipairs(r[2]) do',
  "  local t = redis.call('TYPE', k).ok",
  "  local n = 0",
  "  if t == 'string' then n = redis.call('STRLEN', k)",
  "  elseif t == 'hash' then n = redis.call('HLEN', k)",
  "  elseif t == 'list' then n = redis.call('LLEN', k)",
  "  elseif t == 'set' then n = redis.call('SCARD', k)",
  "  elseif t == 'zset' then n = redis.call('ZCARD', k)",
  "  elseif t == 'stream' then n = redis.call('XLEN', k) end",
  "  out[#out + 1] = { k, t, redis.call('PTTL', k), n }",
  'end',
  'return out',
].join('\n');

export function redisScanArgv(cursor: string, pattern: string, count: number): string[] {
  return ['EVAL', REDIS_SCAN_LUA, '0', cursor || '0', pattern || '*', String(Math.max(10, Math.min(1000, Math.floor(count))))];
}

export interface RedisKeyRow {
  key: string;
  type: string;
  /** ms; -1 = no expiry, -2 = gone. */
  ttlMs: number;
  /** Length in the type's unit (bytes / fields / elements / members / entries). */
  size: number;
}

export function parseScanReply(reply: unknown): { cursor: string; keys: RedisKeyRow[] } {
  if (!Array.isArray(reply) || reply.length === 0) throw new Error('unexpected SCAN reply');
  const [cursor, ...rows] = reply;
  return {
    cursor: String(cursor),
    keys: rows
      .filter((r): r is unknown[] => Array.isArray(r))
      .map((r) => ({ key: String(r[0]), type: String(r[1]), ttlMs: Number(r[2]), size: Number(r[3]) })),
  };
}

/** The read that shows a key's value, capped at `cap` elements. */
export function redisValueArgv(type: string, key: string, cap: number): string[] {
  const n = String(Math.max(1, cap));
  switch (type) {
    case 'hash':
      return ['HSCAN', key, '0', 'COUNT', n];
    case 'set':
      return ['SSCAN', key, '0', 'COUNT', n];
    case 'zset':
      return ['ZRANGE', key, '0', String(cap - 1), 'WITHSCORES'];
    case 'list':
      return ['LRANGE', key, '0', String(cap - 1)];
    case 'stream':
      return ['XRANGE', key, '-', '+', 'COUNT', n];
    default:
      return ['GET', key];
  }
}

/** Edits the key browser offers (each shown as the exact command before it runs). */
export function redisSetArgv(type: string, key: string, field: string | null, value: string): string[] {
  switch (type) {
    case 'hash':
      return ['HSET', key, field ?? '', value];
    case 'set':
      return ['SADD', key, value];
    case 'zset':
      return ['ZADD', key, field ?? '0', value];
    case 'list':
      return field != null ? ['LSET', key, field, value] : ['RPUSH', key, value];
    default:
      return ['SET', key, value, 'KEEPTTL'];
  }
}

export function redisRemoveArgv(type: string, key: string, member: string | null): string[] {
  if (member == null) return ['UNLINK', key];
  switch (type) {
    case 'hash':
      return ['HDEL', key, member];
    case 'set':
      return ['SREM', key, member];
    case 'zset':
      return ['ZREM', key, member];
    case 'stream':
      return ['XDEL', key, member];
    default:
      return ['UNLINK', key];
  }
}

// ── `redis-cli --no-raw` reply parser ────────────────────────────────────────

export type RedisReply = string | number | null | { error: string } | { status: string } | RedisReply[];

function unquote(s: string): string {
  // redis-cli's sdscatrepr: \\ \" \n \r \t \a \b and \xHH for every other byte.
  const bytes: number[] = [];
  const enc = new TextEncoder();
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i]!;
    if (c === '\\') {
      const e = s[i + 1]!;
      i++;
      if (e === 'x') {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(({ n: 10, r: 13, t: 9, a: 7, b: 8 } as Record<string, number>)[e] ?? e.charCodeAt(0));
      continue;
    }
    bytes.push(...enc.encode(c));
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(bytes));
}

function scalar(t: string): RedisReply {
  if (t === '(nil)') return null;
  if (t === '(empty array)' || t === '(empty list or set)') return [];
  let m = /^\(integer\) (-?\d+)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^\(double\) (.+)$/.exec(t);
  if (m) return Number(m[1]);
  m = /^\(error\) (.*)$/.exec(t);
  if (m) return { error: m[1]! };
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return unquote(t);
  return { status: t };
}

/**
 * Parse `--no-raw` output: scalars, `N) ` arrays (indices right-aligned, nested
 * arrays continue at the element's column). Throws on anything unexpected.
 */
export function parseRedisNoRaw(output: string): RedisReply {
  const lines = output.replace(/\r/g, '').split('\n');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return null;
  let li = 0;

  const parseAt = (col: number): RedisReply => {
    const line = lines[li]!;
    const rest = line.slice(col);
    const m = /^( *)(\d+)\) /.exec(rest);
    if (!m) {
      li++;
      return scalar(rest.trim());
    }
    const arr: RedisReply[] = [];
    let expect = 1;
    for (;;) {
      if (li >= lines.length) break;
      const r = lines[li]!.slice(col);
      const mm = /^( *)(\d+)\) /.exec(r);
      if (!mm || Number(mm[2]) !== expect) break;
      // Continuation lines of a nested element start with spaces up to its column.
      if (expect > 1 && lines[li]!.slice(0, col).trim() !== '') break;
      arr.push(parseAt(col + mm[0].length));
      expect++;
    }
    return arr;
  };

  const v = parseAt(0);
  return v;
}
