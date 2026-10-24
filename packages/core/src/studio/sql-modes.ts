/**
 * Fail closed on server string modes.
 *
 * The lexer reads SQL the way a server with DEFAULT settings would. A MySQL
 * server running `ANSI_QUOTES` or `NO_BACKSLASH_ESCAPES`, or a Postgres one
 * with `standard_conforming_strings=off`, reads the same bytes differently:
 * `SELECT 'a\'; DROP TABLE t; -- '` is one harmless string by default and two
 * statements under `NO_BACKSLASH_ESCAPES`. The studio can't know a server's
 * mode, so the verdict has to hold under every one of them:
 *
 *  - several statements under any mode → blocked;
 *  - any other difference (a different class, or a mode the text doesn't
 *    parse under) → at least a write, never a read.
 */
import type { Classification, StatementClass } from './classify';
import { lexSql, type LexResult, type SqlDialect, type SqlLexMode } from './sql-lex';

export const SQL_MODE_VARIANTS: Record<SqlDialect, ReadonlyArray<{ name: string; mode: SqlLexMode }>> = {
  mysql: [
    { name: 'ANSI_QUOTES', mode: { doubleQuoteIdent: true } },
    { name: 'NO_BACKSLASH_ESCAPES', mode: { backslashEscapes: false } },
    { name: 'ANSI_QUOTES + NO_BACKSLASH_ESCAPES', mode: { doubleQuoteIdent: true, backslashEscapes: false } },
  ],
  postgres: [{ name: 'standard_conforming_strings=off', mode: { backslashEscapes: true } }],
};

const RANK: Record<StatementClass, number> = { read: 0, write: 1, destructive: 2 };
const worse = (a: StatementClass, b: StatementClass): StatementClass => (RANK[b] > RANK[a] ? b : a);

/**
 * Classify `sql` under the default mode, then re-read it under every other
 * string mode and fold the differences in, conservatively.
 */
export function classifyAcrossModes(
  sql: string,
  dialect: SqlDialect,
  classifyLexed: (lexed: LexResult) => Classification,
): Classification {
  const base = classifyLexed(lexSql(sql, dialect));
  if (base.blocked) return base;
  let out = base;
  for (const { name, mode } of SQL_MODE_VARIANTS[dialect]) {
    const lexed = lexSql(sql, dialect, mode);
    // Statements completed before an error, plus the one that errored, are still several.
    if (lexed.statements.length > 1 || (lexed.error && lexed.statements.length > 0)) {
      return { ...out, class: worse(out.class, 'write'), blocked: `with ${name} on the server this reads as several statements — run one at a time` };
    }
    const v = lexed.error ? null : classifyLexed(lexed);
    if (v && !v.blocked && v.class === base.class) continue;
    const why = v ? (v.blocked ?? `it is a ${v.class}`) : `it doesn't parse (${lexed.error})`;
    out = {
      ...out,
      class: worse(worse(out.class, v?.class ?? 'write'), 'write'),
      reasons: [...new Set([...out.reasons, `reads differently with ${name} on the server (${why}), so it counts as a write`])],
      ...(v?.blocked ? { blocked: v.blocked } : {}),
    };
  }
  return out;
}
