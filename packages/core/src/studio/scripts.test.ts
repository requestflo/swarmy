import { describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parseControllerEnvelope } from '../protocol/messages';
import { DbQueryPayload, DbQueryResult, STUDIO_DEFAULTS, STUDIO_MAX } from '../protocol/studio';
import { resolveAppDbCreds } from '../protocol/appDbScripts';
import { parseCsv, parseMongoOutput, parseMysqlOutput, parsePsqlOutput, parseRedisNoRaw, redisReplyToGrid, splitStderr, studioScript, documentsToGrid } from './scripts';
import { parseScanReply } from './redis';

const opts = { rowCap: 1000, maxBytes: 1 << 20 };

describe('dbQuery protocol', () => {
  const creds = resolveAppDbCreds('postgres', ['POSTGRES_PASSWORD=x']);
  if (!creds.ok) throw new Error('creds');

  it('round-trips through the controller envelope with defaults applied', () => {
    const frame = {
      v: 1,
      id: randomUUID(),
      ts: Date.now(),
      type: 'dbQuery',
      payload: { commandId: randomUUID(), engine: 'postgres', service: 'app_db', creds: creds.creds, op: { kind: 'sql', statement: 'SELECT 1', access: 'read' } },
    };
    const parsed = parseControllerEnvelope(JSON.parse(JSON.stringify(frame)));
    expect(parsed?.type).toBe('dbQuery');
    if (parsed?.type !== 'dbQuery') throw new Error('type');
    expect(parsed.payload.limits).toEqual({ ...STUDIO_DEFAULTS });
    expect(parsed.payload.op).toEqual({ kind: 'sql', statement: 'SELECT 1', access: 'read' });
  });

  it('carries no credential values — only the recipe', () => {
    const p = DbQueryPayload.parse({ commandId: randomUUID(), engine: 'postgres', service: 's', creds: creds.creds, op: { kind: 'sql', statement: 'SELECT 1', access: 'read' } });
    expect(JSON.stringify(p)).not.toContain('"x"');
    expect(JSON.stringify(p)).toContain('POSTGRES_PASSWORD');
  });

  it('enforces the hard ceilings', () => {
    const base = { commandId: randomUUID(), engine: 'redis', service: 's', creds: creds.creds, op: { kind: 'redis', argv: ['GET', 'k'], access: 'read' } };
    expect(DbQueryPayload.safeParse({ ...base, limits: { rowCap: STUDIO_MAX.rowCap + 1 } }).success).toBe(false);
    expect(DbQueryPayload.safeParse({ ...base, limits: { statementTimeoutMs: STUDIO_MAX.statementTimeoutMs + 1 } }).success).toBe(false);
    expect(DbQueryPayload.safeParse({ ...base, limits: { maxBytes: STUDIO_MAX.maxBytes + 1 } }).success).toBe(false);
    expect(DbQueryPayload.safeParse({ ...base, op: { kind: 'sql', statement: 'x'.repeat(STUDIO_MAX.statementBytes + 1), access: 'read' } }).success).toBe(false);
    expect(DbQueryPayload.safeParse({ ...base, database: 'a b' }).success).toBe(false);
    expect(DbQueryPayload.safeParse({ ...base, engine: 'sqlite' }).success).toBe(false);
  });

  it('result round-trips', () => {
    const r = DbQueryResult.parse({ engine: 'mysql', columns: ['a'], rows: [['1'], [null]], rowCount: 2, durationMs: 4 });
    expect(DbQueryResult.parse(JSON.parse(JSON.stringify(r)))).toEqual(r);
  });
});

describe('scripts', () => {
  it('resolve credentials in-task and never print them', () => {
    const c = resolveAppDbCreds('mysql', ['MYSQL_ROOT_PASSWORD_FILE=/run/secrets/root']);
    if (!c.ok) throw new Error('creds');
    const s = studioScript('mysql', c.creds);
    expect(s).toContain('SWARMY_DB_PASSWORD=$v');
    expect(s).not.toMatch(/printf 'SWARMY_DB_PASSWORD/);
    expect(s).toContain('--binary-mode');
    expect(s).toContain('START TRANSACTION READ ONLY');
    expect(s).toContain('/dev/shm/swarmy-studio-');
  });
  it('postgres read runs a read-only session + snapshot-first read-only transaction with a timeout', () => {
    const c = resolveAppDbCreds('postgres', ['POSTGRES_PASSWORD=x']);
    if (!c.ok) throw new Error('creds');
    const s = studioScript('postgres', c.creds);
    expect(s).toContain('default_transaction_read_only=on');
    expect(s).toContain("'BEGIN READ ONLY'");
    expect(s).toContain('statement_timeout=$T');
    expect(s).toContain('-c "$SWARMY_Q"');
    expect(s).not.toContain('-f -'); // -c never interprets psql meta-commands
  });
});

describe('psql CSV', () => {
  const N = '__null_abc__';
  it('distinguishes NULL, empty string, quotes and newlines', () => {
    const out = `a,b,c,d\n1,${N},"","x,y""z\nw"\n`;
    const r = parsePsqlOutput(out, N, { ...opts, access: 'write' });
    expect(r.columns).toEqual(['a', 'b', 'c', 'd']);
    expect(r.rows).toEqual([['1', null, '', 'x,y"z\nw']]);
  });
  it('strips the read snapshot probe and a write command tag', () => {
    expect(parsePsqlOutput('swarmy_snapshot\n1\nx\n5\n', N, { ...opts, access: 'read' }).rows).toEqual([['5']]);
    const w = parsePsqlOutput('UPDATE 3\n', N, { ...opts, access: 'write' });
    expect(w).toMatchObject({ status: 'UPDATE 3', affected: 3, rows: [] });
    const ret = parsePsqlOutput('id\n1\n2\nINSERT 0 2\n', N, { ...opts, access: 'write' });
    expect(ret).toMatchObject({ columns: ['id'], rows: [['1'], ['2']], affected: 2 });
  });
  it('enforces the row cap and flags a byte-cut partial row', () => {
    const rows = Array.from({ length: 10 }, (_, i) => String(i)).join('\n');
    expect(parsePsqlOutput(`n\n${rows}\n`, N, { rowCap: 3, maxBytes: 1 << 20, access: 'read' })).toMatchObject({ rows: [['0'], ['1'], ['2']], truncated: true });
    const cut = parsePsqlOutput('a\n"long value that was cut', N, { rowCap: 10, maxBytes: 1 << 20, access: 'read' });
    expect(cut).toMatchObject({ rows: [], truncated: true });
    const bytes = parsePsqlOutput('a\n1111\n2222\n3333\n', N, { rowCap: 10, maxBytes: 9, access: 'read' });
    expect(bytes.truncated).toBe(true);
    expect(bytes.rows).toEqual([['1111']]);
  });
  it('parseCsv keeps CRLF and trailing-empty fields', () => {
    expect(parseCsv('a,b\r\n1,\r\n').rows).toEqual([['a', 'b'], ['1', '']]);
  });
  it('splitStderr pulls the client exit code out', () => {
    expect(splitStderr('ERROR:  boom\nSWARMY_RC=1\n')).toEqual({ rc: 1, text: 'ERROR:  boom' });
  });
});

describe('mysql --xml', () => {
  const xml = `<?xml version="1.0"?>

<resultset statement="SELECT …" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
	<field name="a">1</field>
	<field name="b" xsi:nil="true" />
	<field name="c"></field>
	<field name="d">x&lt;y&amp;&quot;z
	w</field>
  </row>
</resultset>
<resultset statement="SELECT ROW_COUNT() AS swarmy_affected" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <row>
	<field name="swarmy_affected">-1</field>
  </row>
</resultset>
`;
  it('reads NULL vs empty, entities, and drops the ROW_COUNT trailer', () => {
    const r = parseMysqlOutput(xml, { ...opts, access: 'write' });
    expect(r.columns).toEqual(['a', 'b', 'c', 'd']);
    expect(r.rows).toEqual([['1', null, '', 'x<y&"z\n\tw']]);
    expect(r.affected).toBeUndefined();
  });
  it('reports affected rows of a write', () => {
    const w = parseMysqlOutput('<resultset statement="x"><row><field name="swarmy_affected">4</field></row></resultset>', { ...opts, access: 'write' });
    expect(w).toMatchObject({ affected: 4, rows: [] });
  });
  it('a byte-cut result set is truncated', () => {
    const r = parseMysqlOutput('<resultset statement="x"><row><field name="a">1</field></row><row><field name="a">2', { ...opts, access: 'read' });
    expect(r).toMatchObject({ rows: [['1']], truncated: true });
  });
});

describe('mongosh output', () => {
  it('parses documents + reply, and errors', () => {
    const line = 'SWARMY_JSON ' + JSON.stringify({ ok: true, reply: JSON.stringify({ cursor: { id: 0 }, ok: 1 }), docs: [JSON.stringify({ _id: { $oid: 'a' }, n: 1 })], truncated: false });
    const r = parseMongoOutput(`noise\n${line}\n`);
    expect(r.docs).toEqual([{ _id: { $oid: 'a' }, n: 1 }]);
    expect(documentsToGrid(r.docs!)).toEqual({ columns: ['_id', 'n'], rows: [[{ $oid: 'a' }, 1]] });
    expect(parseMongoOutput('SWARMY_JSON {"ok":false,"error":"no such command"}')).toMatchObject({ ok: false, error: 'no such command' });
    expect(() => parseMongoOutput('')).toThrow();
  });
});

describe('redis-cli --no-raw', () => {
  it('parses scalars', () => {
    expect(parseRedisNoRaw('OK\n')).toEqual({ status: 'OK' });
    expect(parseRedisNoRaw('(integer) 42\n')).toBe(42);
    expect(parseRedisNoRaw('(nil)\n')).toBeNull();
    expect(parseRedisNoRaw('"x\\"y\\nz"\n')).toBe('x"y\nz');
    expect(parseRedisNoRaw('"caf\\xc3\\xa9"\n')).toBe('café');
    expect(parseRedisNoRaw('(error) ERR unknown command\n')).toEqual({ error: 'ERR unknown command' });
    expect(parseRedisNoRaw('(empty array)\n')).toEqual([]);
  });
  it('parses nested arrays (SCAN, EVAL tables) and right-aligned indices', () => {
    expect(parseRedisNoRaw('1) "0"\n2) 1) "l"\n   2) "a b"\n')).toEqual(['0', ['l', 'a b']]);
    const scan = '1) "0"\n2) 1) "a b"\n   2) "string"\n   3) (integer) -1\n   4) (integer) 5\n3) 1) "h"\n   2) "hash"\n   3) (integer) 900\n   4) (integer) 2\n';
    expect(parseScanReply(parseRedisNoRaw(scan))).toEqual({
      cursor: '0',
      keys: [
        { key: 'a b', type: 'string', ttlMs: -1, size: 5 },
        { key: 'h', type: 'hash', ttlMs: 900, size: 2 },
      ],
    });
    const ten = Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, ' ')}) "v${i}"`).join('\n');
    expect(parseRedisNoRaw(ten)).toEqual(Array.from({ length: 11 }, (_, i) => `v${i}`));
    expect(parseRedisNoRaw('1) (integer) 1\n2) 1) "a"\n   2) (integer) 2\n3) hash\n')).toEqual([1, ['a', 2], { status: 'hash' }]);
  });
  it('grids common replies', () => {
    expect(redisReplyToGrid(['HGETALL', 'h'], ['f1', 'v1', 'f2', 'v2'])).toEqual({ columns: ['field', 'value'], rows: [['f1', 'v1'], ['f2', 'v2']] });
    expect(redisReplyToGrid(['GET', 'k'], 'v')).toEqual({ columns: ['value'], rows: [['v']] });
  });
});
