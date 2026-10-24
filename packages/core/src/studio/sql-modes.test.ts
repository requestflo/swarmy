/**
 * The studio can't know a server's string mode, so a verdict must hold under
 * all of them (M12). Inputs are written as the SQL text the user types; the
 * `String.raw` keeps every backslash literal.
 */
import { describe, expect, it } from 'bun:test';
import { classifySql } from './classify';
import { lexSql } from './sql-lex';
import { browseSql, updateRowSql } from './sql';

const my = (s: string) => classifySql(s, 'mysql');
const pg = (s: string) => classifySql(s, 'postgres');

describe('lexer string modes', () => {
  it('MySQL: ANSI_QUOTES makes "…" an identifier; NO_BACKSLASH_ESCAPES makes \\ literal', () => {
    expect(lexSql('SELECT "a"', 'mysql').statements[0]!.tokens[1]!.kind).toBe('string');
    expect(lexSql('SELECT "a"', 'mysql', { doubleQuoteIdent: true }).statements[0]!.tokens[1]!.kind).toBe('ident');
    const drift = String.raw`SELECT 'a\'; DROP TABLE t; -- '`;
    expect(lexSql(drift, 'mysql').statements).toHaveLength(1);
    expect(lexSql(drift, 'mysql', { backslashEscapes: false }).statements).toHaveLength(2);
  });

  it('Postgres: standard_conforming_strings=off makes \\ escape inside plain strings', () => {
    const drift = String.raw`SELECT 'x\''; DROP TABLE t; --'`;
    expect(lexSql(drift, 'postgres').statements).toHaveLength(1);
    expect(lexSql(drift, 'postgres', { backslashEscapes: true }).statements).toHaveLength(2);
  });
});

describe('classification fails closed across string modes', () => {
  it('MySQL: a statement that hides a second one under NO_BACKSLASH_ESCAPES is blocked', () => {
    const c = my(String.raw`SELECT 'a\'; DROP TABLE t; -- '`);
    expect(c.blocked).toContain('NO_BACKSLASH_ESCAPES');
    expect(c.class).not.toBe('read');
  });

  it('Postgres: a statement that hides a second one under standard_conforming_strings=off is blocked', () => {
    expect(pg(String.raw`SELECT 'x\''; DROP TABLE t; --'`).blocked).toContain('standard_conforming_strings');
  });

  it('MySQL: a dangerous call that is only a string by default is destructive (ANSI_QUOTES reads a call)', () => {
    const c = my(`SELECT "load_file"('/etc/passwd')`);
    expect(c.class).toBe('destructive');
    expect(c.reasons.join(' ')).toContain('ANSI_QUOTES');
  });

  it('text that only parses under the default mode counts as a write, not a read', () => {
    const c = my(String.raw`SELECT 'it\'s'`);
    expect(c.class).toBe('write');
    expect(c.blocked).toBeUndefined();
    expect(c.reasons.join(' ')).toContain('NO_BACKSLASH_ESCAPES');
  });

  it('a write never drops to a read because another mode reads it differently', () => {
    expect(my(String.raw`UPDATE t SET a = 'x\'y' WHERE id = 1`).class).toBe('write');
  });

  it('mode-proof text keeps its verdict', () => {
    expect(my(`SELECT * FROM t WHERE name = 'o''reilly'`)).toMatchObject({ class: 'read', reasons: [] });
    expect(my(`SELECT "x", name FROM t`)).toMatchObject({ class: 'read', reasons: [] });
    expect(pg(String.raw`SELECT E'a\'b', 'C:\path'`)).toMatchObject({ class: 'read', reasons: [] });
  });

  it("the studio's own builders stay mode-proof, even with quotes and backslashes in values", () => {
    const v = "it's \\ a test\\"; // it's \ a test\
    const table = { name: 'users' };
    expect(my(browseSql('mysql', { table, limit: 50, offset: 0, filters: [{ column: 'name', op: '=', value: v }] }))).toMatchObject({ class: 'read', reasons: [] });
    expect(my(browseSql('mysql', { table, limit: 50, offset: 0, filters: [{ column: 'name', op: 'contains', value: v }] }))).toMatchObject({ class: 'read', reasons: [] });
    expect(my(updateRowSql('mysql', table, { id: 7 }, { name: v })).class).toBe('write');
  });
});
