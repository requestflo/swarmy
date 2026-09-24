import { describe, expect, it } from 'bun:test';
import { classifyMongo, classifyRedis, classifySql, singleStatementText } from './classify';
import { parseMongoInput } from './mongo';
import { tokenizeRedis } from './redis';
import { PG_SCHEMA_SQL, MYSQL_SCHEMA_SQL, browseSql, updateRowSql, insertRowSql, deleteRowSql, pgStatStatementsSql, PG_ACTIVITY_SQL, PG_INSIGHTS_PROBE_SQL, MYSQL_INSIGHTS_PROBE_SQL, mysqlDigestSql, mysqlSlowLogSql, MYSQL_ACTIVITY_SQL } from './sql';

const pg = (s: string) => classifySql(s, 'postgres');
const my = (s: string) => classifySql(s, 'mysql');

describe('SQL classification — reads', () => {
  it.each([
    'SELECT 1',
    'select * from users where id = 1;',
    '  -- leading comment\n SELECT now()',
    '/* block */ SELECT 1 /* trailing */',
    'WITH a AS (SELECT 1) SELECT * FROM a',
    'EXPLAIN SELECT * FROM t',
    'SHOW search_path',
    'VALUES (1), (2)',
    "SELECT 'DELETE FROM users' AS s",
    'SELECT "update" FROM t',
    "SELECT $$ DROP TABLE x; $$ AS body",
    "SELECT $fn$ ; DELETE FROM t $fn$",
    "SELECT E'it\\'s; DROP TABLE t'",
    'SELECT 1 /* nested /* ; DROP TABLE t */ still comment */',
    'COPY (SELECT 1) TO STDOUT',
  ])('read: %s', (s) => {
    const c = pg(s);
    expect(c.blocked).toBeUndefined();
    expect(c.class).toBe('read');
  });

  it('MySQL strings and backtick identifiers are not code', () => {
    expect(my("SELECT 'a;b', \"c;d\", `e;f` FROM t").class).toBe('read');
    expect(my("SELECT 'it\\'s; DROP TABLE t'").blocked).toBeUndefined();
    expect(my('SELECT 1 # comment; DROP TABLE t').class).toBe('read');
    expect(my('SELECT REPLACE(name, "a", "b") FROM t').class).toBe('read');
    expect(my('SELECT 1 INTO @x').class).toBe('read');
  });

  it('introspection and insight queries the studio builds are reads', () => {
    for (const s of [PG_SCHEMA_SQL, PG_ACTIVITY_SQL, PG_INSIGHTS_PROBE_SQL, pgStatStatementsSql(true), pgStatStatementsSql(false)]) {
      expect(pg(s)).toMatchObject({ class: 'read' });
      expect(pg(s).blocked).toBeUndefined();
    }
    for (const s of [MYSQL_SCHEMA_SQL, MYSQL_INSIGHTS_PROBE_SQL, mysqlDigestSql(), mysqlSlowLogSql(), MYSQL_ACTIVITY_SQL]) {
      expect(my(s).class).toBe('read');
      expect(my(s).blocked).toBeUndefined();
    }
    expect(pg(browseSql('postgres', { table: { schema: 'public', name: 'users' }, limit: 50, offset: 100, orderBy: 'id', dir: 'desc', filters: [{ column: 'email', op: 'contains', value: "o'reilly%" }] })).class).toBe('read');
  });
});

describe('SQL classification — writes', () => {
  it.each([
    "INSERT INTO t (a) VALUES ('x')",
    "UPDATE t SET a = 1 WHERE id = 3",
    'DELETE FROM t WHERE id = 3',
    'DELETE FROM t WHERE id IN (SELECT id FROM u WHERE flag)',
    'INSERT INTO t SELECT * FROM u',
    "INSERT INTO t (a) VALUES (1) ON CONFLICT (a) DO UPDATE SET a = excluded.a",
    'SELECT * FROM t WHERE id = 1 FOR UPDATE',
    'MERGE INTO t USING u ON t.id = u.id WHEN MATCHED THEN UPDATE SET a = u.a',
  ])('write: %s', (s) => {
    const c = pg(s);
    expect(c.blocked).toBeUndefined();
    expect(c.class).toBe('write');
  });

  it('a data-modifying CTE is at least a write', () => {
    const c = pg('WITH gone AS (DELETE FROM sessions WHERE expires < now() RETURNING id) SELECT count(*) FROM gone');
    expect(c.class).toBe('write');
    expect(c.reasons.join(' ')).toContain('DELETE');
  });

  it('MySQL upsert and single-row edits are writes', () => {
    expect(my("INSERT INTO t VALUES (1) ON DUPLICATE KEY UPDATE a = 2").class).toBe('write');
    expect(my("UPDATE `t` SET `a` = 'x' WHERE `id` = '1' LIMIT 1").class).toBe('write');
  });

  it('the row edits the grid builds classify as writes', () => {
    const t = { schema: 'public', name: 'users' };
    expect(pg(updateRowSql('postgres', t, { id: 7 }, { email: "a'b@c" })).class).toBe('write');
    expect(pg(insertRowSql('postgres', t, { email: 'x' })).class).toBe('write');
    expect(pg(deleteRowSql('postgres', t, { id: '7' })).class).toBe('write');
    expect(my(deleteRowSql('mysql', { name: 'users' }, { id: '7' })).class).toBe('write');
  });
});

describe('SQL classification — destructive', () => {
  it.each([
    ['DROP TABLE users', 'schema change'],
    ['TRUNCATE users', 'TRUNCATE'],
    ['ALTER TABLE t ADD COLUMN x int', 'schema change'],
    ['CREATE INDEX ON t (a)', 'schema change'],
    ['DELETE FROM users', 'without WHERE'],
    ['delete from users -- WHERE id = 1', 'without WHERE'],
    ['UPDATE users SET admin = true', 'without WHERE'],
    ['DELETE FROM users WHERE true', 'always-true'],
    ['DELETE FROM users WHERE 1 = 1', 'always-true'],
    ['UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)', 'without WHERE'],
    ['WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x', 'without WHERE'],
    ['WITH x AS (SELECT 1) DELETE FROM t', 'without WHERE'],
    ['EXPLAIN ANALYZE DELETE FROM t', 'without WHERE'],
    ['SELECT pg_terminate_backend(123)', 'pg_terminate_backend'],
    ['SELECT * INTO new_table FROM t', 'creates a table'],
    ["DO $$ BEGIN DELETE FROM t; END $$", 'anonymous code block'],
    ['VACUUM FULL t', 'VACUUM FULL'],
    ['GRANT ALL ON t TO bob', 'schema change'],
    ['FROBNICATE t', 'unrecognised'],
  ])('destructive: %s', (s, why) => {
    const c = pg(s);
    expect(c.class).toBe('destructive');
    expect(c.blocked).toBeUndefined();
    expect(c.reasons.join(' | ')).toContain(why);
  });

  it('MySQL: SET GLOBAL, executable comments, DELETE … LIMIT without WHERE', () => {
    expect(my('SET GLOBAL max_connections = 1').class).toBe('destructive');
    expect(my('SELECT 1 /*!50000 , (SELECT 1) */').class).toBe('read');
    expect(my('DELETE FROM t LIMIT 10').class).toBe('destructive');
    expect(my('SELECT LOAD_FILE("/etc/passwd")').class).toBe('destructive');
  });
});

describe('SQL classification — blocked', () => {
  it('`;`-chained statements are refused, classified by the worst part', () => {
    const c = pg('SELECT 1; DROP TABLE users');
    expect(c.blocked).toContain('2 statements');
    expect(c.class).toBe('destructive');
    expect(pg('SELECT 1; SELECT 2;').blocked).toContain('2 statements');
    // a trailing `;` (and a comment after it) is one statement
    expect(pg('SELECT 1; -- done').blocked).toBeUndefined();
  });

  it('chaining hidden behind comments / strings is still seen', () => {
    expect(pg("SELECT '--'; DELETE FROM t").blocked).toContain('2 statements');
    expect(pg('SELECT 1 /* */; DELETE FROM t').blocked).toContain('2 statements');
    // MySQL: `--` needs whitespace to start a comment, so this is two statements
    expect(my('SELECT 1--1; DROP TABLE t').blocked).toContain('2 statements');
    // …and an executable comment's body is code
    expect(my('SELECT 1 /*! ; DROP TABLE t */').blocked).toContain('2 statements');
    expect(pg('SET transaction_read_only = off; INSERT INTO t VALUES (1)').blocked).toContain('2 statements');
  });

  it('client meta-commands and transaction control', () => {
    expect(pg('\\! id').blocked).toContain('meta-commands');
    expect(pg('SELECT 1 \\gexec').blocked).toContain('meta-commands');
    expect(my('SELECT 1 \\! id').blocked).toContain('meta-commands');
    expect(pg('BEGIN').blocked).toContain('transaction control');
    expect(pg('COMMIT').blocked).toContain('transaction control');
    expect(my('START TRANSACTION').blocked).toContain('transaction control');
  });

  it('server file / program I/O', () => {
    expect(pg("COPY t FROM PROGRAM 'id'").blocked).toContain('PROGRAM');
    expect(pg("COPY t TO '/tmp/x'").blocked).toContain('server file');
    expect(my("SELECT * FROM t INTO OUTFILE '/tmp/x'").blocked).toContain('OUTFILE');
    expect(my("LOAD DATA INFILE '/etc/passwd' INTO TABLE t").blocked).toContain('LOAD');
  });

  it('unterminated input is refused, not guessed at', () => {
    expect(pg("SELECT 'oops").blocked).toContain('unterminated');
    expect(pg('SELECT $$ never closed').blocked).toContain('unterminated');
    expect(pg('SELECT 1 /* open').blocked).toContain('unterminated');
  });

  it('singleStatementText strips the trailing `;`', () => {
    expect(singleStatementText('SELECT 1;  ', 'postgres')).toBe('SELECT 1');
    expect(singleStatementText('SELECT 1; SELECT 2', 'postgres')).toBeNull();
  });
});

describe('Mongo classification', () => {
  const cls = (s: string) => classifyMongo(parseMongoInput(s).doc);
  it('reads', () => {
    expect(cls('db.users.find({ age: { $gt: 30 } }).sort({ age: -1 }).limit(20)').class).toBe('read');
    expect(cls('{"aggregate": "users", "pipeline": [{"$match": {}}], "cursor": {}}').class).toBe('read');
    expect(cls('db.users.countDocuments({})').class).toBe('read');
    expect(cls('db.getCollectionNames()').class).toBe('read');
  });
  it('writes', () => {
    expect(cls("db.users.insertOne({ name: 'a' })").class).toBe('write');
    expect(cls("db.users.updateOne({ _id: ObjectId('6ab5652bd44c40aee977f4df') }, { $set: { a: 1 } })").class).toBe('write');
    expect(cls('db.users.deleteOne({ name: "x" })').class).toBe('write');
    expect(cls('db.users.aggregate([{ $match: {} }, { $out: "copy" }])').class).toBe('write');
  });
  it('destructive', () => {
    expect(cls('db.users.deleteMany({})').class).toBe('destructive');
    expect(cls('db.users.updateMany({}, { $set: { a: 1 } })').class).toBe('destructive');
    expect(cls('db.users.drop()').class).toBe('destructive');
    expect(cls('db.dropDatabase()').class).toBe('destructive');
    expect(cls('db.users.createIndex({ email: 1 })').class).toBe('destructive');
    expect(cls('{"shutdown": 1}').class).toBe('destructive');
    expect(cls('{"frobnicate": 1}').class).toBe('destructive');
  });
  it('blocked', () => {
    expect(cls('{"getMore": 1, "collection": "x"}').blocked).toBeDefined();
    expect(cls('{"saslStart": 1}').blocked).toBeDefined();
  });
  it('shorthand translates to the command document', () => {
    expect(parseMongoInput("db.users.find({ name: /^a/i }, { name: 1 }).skip(5).limit(2)").doc).toEqual({
      find: 'users',
      filter: { name: { $regex: '^a', $options: 'i' } },
      projection: { name: 1 },
      skip: 5,
      limit: 2,
    });
    expect(parseMongoInput("db.getCollection('a.b').findOne({ d: ISODate('2024-01-01') })").doc).toEqual({
      find: 'a.b',
      filter: { d: { $date: '2024-01-01' } },
      limit: 1,
    });
    expect(() => parseMongoInput('db.users.find({ $where: function () {} })')).toThrow();
    expect(() => parseMongoInput('while(true){}')).toThrow();
  });
});

describe('Redis classification', () => {
  const c = (s: string) => classifyRedis(tokenizeRedis(s));
  it('reads / writes / destructive / blocked', () => {
    expect(c('GET "a b"').class).toBe('read');
    expect(c('hgetall user:1').class).toBe('read');
    expect(c('SCAN 0 MATCH user:* COUNT 100').class).toBe('read');
    expect(c('SET k v').class).toBe('write');
    expect(c('DEL k').class).toBe('write');
    expect(c('SORT list STORE out').class).toBe('write');
    expect(c('SORT list').class).toBe('read');
    expect(c('FLUSHALL').class).toBe('destructive');
    expect(c('EVAL "return 1" 0').class).toBe('destructive');
    expect(c('SLOWLOG RESET').class).toBe('destructive');
    expect(c('CONFIG GET requirepass').blocked).toBeDefined();
    expect(c('AUTH secret').blocked).toBeDefined();
    expect(c('MULTI').blocked).toBeDefined();
  });
  it('tokenizes like redis-cli', () => {
    expect(tokenizeRedis(`SET "a b" 'it\\'s' "x\\ny\\x41"`)).toEqual(['SET', 'a b', "it's", 'x\nyA']);
    expect(() => tokenizeRedis('GET "open')).toThrow();
  });
});
