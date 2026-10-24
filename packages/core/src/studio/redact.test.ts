import { describe, expect, it } from 'bun:test';
import { auditStatement, redactMongo, redactRedis, redactSql, STUDIO_AUDIT_STATEMENT_MAX } from './redact';

describe('studio audit: SQL keeps its shape, never its literals', () => {
  it('strings and numbers become ?, identifiers and keywords stay as written', () => {
    expect(redactSql(`UPDATE "Users" SET ssn = '123-45-6789', age=42 WHERE id = 7`, 'postgres')).toBe('UPDATE "Users" SET ssn = ?, age=? WHERE id = ?');
    expect(redactSql("SELECT * FROM `Orders` WHERE note = \"vip\" LIMIT 50", 'mysql')).toBe('SELECT * FROM `Orders` WHERE note = ? LIMIT ?');
  });

  it('secrets in every literal form are stripped: E-strings, dollar quotes, escaped quotes', () => {
    const out = redactSql(String.raw`CREATE USER bob WITH PASSWORD E'pa\'ss'; DO $x$ BEGIN PERFORM 'k3y'; END $x$`, 'postgres');
    expect(out).not.toMatch(/pa|ss|k3y/);
    expect(out).toBe('CREATE USER bob WITH PASSWORD ?; DO ?');
    expect(redactSql(`SET PASSWORD = 'hunter2'`, 'mysql')).toBe('SET PASSWORD = ?');
  });

  it('comments are dropped, layout collapses, operators and casts stay tight', () => {
    expect(redactSql('SELECT a::text,\n  b -- the secret is x\nFROM t /* y */ WHERE a <= $1', 'postgres')).toBe('SELECT a::text, b FROM t WHERE a <= $1');
  });

  it('MySQL executable comments are code, so they are kept (inlined), literals stripped', () => {
    expect(redactSql("SELECT /*!50000 'x', */ 1", 'mysql')).toBe('SELECT ?, ?');
  });

  it('unreadable text keeps only what precedes the first quote or comment', () => {
    expect(redactSql("SELECT * FROM t WHERE pw = 'unterminated", 'postgres')).toBe('SELECT * FROM t WHERE pw = …');
    expect(redactSql('SELECT 1 /* open', 'postgres')).toBe('SELECT 1 …');
  });
});

describe('studio audit: Mongo and Redis', () => {
  it('Mongo keeps keys, operators and the target collection; values become ?', () => {
    expect(redactMongo('{"find":"users","filter":{"email":"ann@example.com","age":{"$gt":30}},"limit":5}')).toBe(
      '{"find":"users","filter":{"email":"?","age":{"$gt":"?"}},"limit":"?"}',
    );
    expect(redactMongo('{"insert":"users","documents":[{"name":"ann","admin":true}]}')).toBe('{"insert":"users","documents":[{"name":"?","admin":true}]}');
    expect(redactMongo('{"ping":1}')).toBe('{"ping":1}');
    expect(redactMongo('not json')).toBe('?');
  });

  it('Redis keeps the command (and sub-command); keys and values become ?', () => {
    expect(redactRedis(['set', 'session:ann', 'sk-live-123'])).toBe('SET ? ?');
    expect(redactRedis(['OBJECT', 'encoding', 'user:1'])).toBe('OBJECT ENCODING ?');
    expect(redactRedis(['PING'])).toBe('PING');
  });
});

describe('auditStatement', () => {
  it('dispatches on the op kind and caps the length', () => {
    expect(auditStatement({ kind: 'sql', statement: "SELECT 'x'", dialect: 'postgres' })).toBe('SELECT ?');
    expect(auditStatement({ kind: 'redis', argv: ['GET', 'k'] })).toBe('GET ?');
    const long = auditStatement({ kind: 'sql', statement: `SELECT ${'col, '.repeat(500)}x FROM t`, dialect: 'postgres' });
    expect(long.length).toBe(STUDIO_AUDIT_STATEMENT_MAX + 1);
    expect(long.endsWith('…')).toBe(true);
  });
});
