import { describe, expect, it } from 'bun:test';
import { SERVICE_ENV_KEY, diffEnv, looksSecret, maskValue, parseDotenv } from './dotenv';

const kv = (text: string) => Object.fromEntries(parseDotenv(text).entries.map((e) => [e.key, e.value]));

describe('parseDotenv — golden', () => {
  it('parses the full grab-bag paste', () => {
    const paste = [
      '# app config',
      '',
      'export NODE_ENV=production',
      'PORT = 3000',
      'NAME=plain value   # trailing comment',
      'HASH=abc#not-a-comment',
      'DQ="line one\\nline two \\"quoted\\""',
      "SQ='literal \\n $HOME'",
      'EMPTY=',
      'EMPTY_DQ=""',
      'URL=postgres://u:p@db:5432/app?sslmode=require',
      'MULTI="-----BEGIN KEY-----',
      'abc',
      '-----END KEY-----"',
      "BT=`a",
      "b`",
      'REF=${OTHER}',
      '  INDENTED=yes',
    ].join('\n');
    const r = parseDotenv(paste);
    expect(r.warnings).toEqual([]);
    expect(r.entries).toEqual([
      { key: 'NODE_ENV', value: 'production', line: 3 },
      { key: 'PORT', value: '3000', line: 4 },
      { key: 'NAME', value: 'plain value', line: 5 },
      { key: 'HASH', value: 'abc#not-a-comment', line: 6 },
      { key: 'DQ', value: 'line one\nline two "quoted"', line: 7 },
      { key: 'SQ', value: 'literal \\n $HOME', line: 8 },
      { key: 'EMPTY', value: '', line: 9 },
      { key: 'EMPTY_DQ', value: '', line: 10 },
      { key: 'URL', value: 'postgres://u:p@db:5432/app?sslmode=require', line: 11 },
      { key: 'MULTI', value: '-----BEGIN KEY-----\nabc\n-----END KEY-----', line: 12 },
      { key: 'BT', value: 'a\nb', line: 15 },
      { key: 'REF', value: '${OTHER}', line: 17 },
      { key: 'INDENTED', value: 'yes', line: 18 },
    ]);
  });

  it('CRLF + BOM are tolerated', () => {
    expect(kv('﻿A=1\r\nB="x"\r\n')).toEqual({ A: '1', B: 'x' });
  });

  it('duplicates: last wins, warning names both lines, order follows the winner', () => {
    const r = parseDotenv('A=1\nB=2\nA=3');
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([
      ['B', '2'],
      ['A', '3'],
    ]);
    expect(r.warnings).toEqual([{ line: 3, message: 'A is also set on line 1 — using line 3' }]);
  });

  it('located warnings: junk line, trailing text, bad key, unterminated quote', () => {
    const r = parseDotenv('just words\nC="x" junk\n1BAD=v\nA="open');
    expect(r.entries.map((e) => [e.key, e.value])).toEqual([
      ['C', 'x'],
      ['A', 'open'],
    ]);
    expect(r.warnings.map((w) => w.line)).toEqual([1, 2, 3, 4]);
  });

  it('a quote spanning lines swallows until its closing quote', () => {
    expect(kv('A="one\nB=two"\nC=3')).toEqual({ A: 'one\nB=two', C: '3' });
  });

  it('unterminated quote at the end keeps the rest of the line and warns', () => {
    const r = parseDotenv('A=1\nB="never closed');
    expect(r.entries).toEqual([
      { key: 'A', value: '1', line: 1 },
      { key: 'B', value: 'never closed', line: 2 },
    ]);
    expect(r.warnings[0]?.message).toContain('unterminated');
  });

  it('service key rule: lowercase / dotted keys skipped with a warning', () => {
    const r = parseDotenv('GOOD=1\nlower=2\nA.B=3', { keyPattern: SERVICE_ENV_KEY, keyRule: 'UPPER_SNAKE_CASE' });
    expect(r.entries.map((e) => e.key)).toEqual(['GOOD']);
    expect(r.warnings).toEqual([
      { line: 2, message: 'lower: invalid name (UPPER_SNAKE_CASE) — skipped' },
      { line: 3, message: 'A.B: invalid name (UPPER_SNAKE_CASE) — skipped' },
    ]);
  });
});

describe('looksSecret', () => {
  const secret = ['DB_PASSWORD', 'STRIPE_SECRET_KEY', 'API_KEY', 'GITHUB_TOKEN', 'JWT_SECRET', 'AWS_SECRET_ACCESS_KEY', 'SENTRY_DSN', 'SESSION_SALT', 'PRIVATE_KEY', 'OAUTH_CLIENT_SECRET', 'BASIC_AUTH'];
  const plain = ['PORT', 'NODE_ENV', 'LOG_LEVEL', 'NEXT_PUBLIC_API_KEY', 'STRIPE_PUBLIC_KEY', 'VITE_KEY', 'AUTHOR', 'MONKEY_COUNT'];
  for (const k of secret) it(`${k} → secret`, () => expect(looksSecret(k)).toBe(true));
  for (const k of plain) it(`${k} → plain`, () => expect(looksSecret(k)).toBe(false));
  it('value shapes win over a harmless name', () => {
    expect(looksSecret('DATABASE_URL', 'postgres://app:hunter2@db/app')).toBe(true);
    expect(looksSecret('DATABASE_URL', 'postgres://db/app')).toBe(false);
    expect(looksSecret('X', 'sk_live_abcdefgh12345')).toBe(true);
    expect(looksSecret('X', 'ghp_' + 'a'.repeat(36))).toBe(true);
    expect(looksSecret('NEXT_PUBLIC_X', 'sk_live_abcdefgh12345')).toBe(true);
  });
});

describe('diffEnv — golden', () => {
  const current = { PORT: '3000', LOG_LEVEL: 'info', DB_PASSWORD: 'old' };
  const paste = parseDotenv('PORT=3000\nLOG_LEVEL=debug\nAPI_KEY=k1\nNEW_FLAG=on').entries;

  it('merge keeps unmentioned keys', () => {
    const d = diffEnv(current, paste);
    expect(d.rows).toEqual([
      { key: 'PORT', kind: 'unchanged', before: '3000', after: '3000', secret: false },
      { key: 'LOG_LEVEL', kind: 'changed', before: 'info', after: 'debug', secret: false },
      { key: 'DB_PASSWORD', kind: 'unchanged', before: 'old', after: 'old', secret: true },
      { key: 'API_KEY', kind: 'added', after: 'k1', secret: true },
      { key: 'NEW_FLAG', kind: 'added', after: 'on', secret: false },
    ]);
    expect(d.next).toEqual({ PORT: '3000', LOG_LEVEL: 'debug', DB_PASSWORD: 'old', API_KEY: 'k1', NEW_FLAG: 'on' });
    expect(d.counts).toEqual({ added: 2, changed: 1, removed: 0, unchanged: 2 });
  });

  it('replace removes unmentioned keys', () => {
    const d = diffEnv(current, paste, 'replace');
    expect(d.rows.find((r) => r.key === 'DB_PASSWORD')).toEqual({ key: 'DB_PASSWORD', kind: 'removed', before: 'old', secret: true });
    expect(d.next).toEqual({ PORT: '3000', LOG_LEVEL: 'debug', API_KEY: 'k1', NEW_FLAG: 'on' });
    expect(d.counts).toEqual({ added: 2, changed: 1, removed: 1, unchanged: 1 });
  });

  it('empty current → all added', () => {
    expect(diffEnv({}, paste).counts).toEqual({ added: 4, changed: 0, removed: 0, unchanged: 0 });
  });
});

it('maskValue never leaks content', () => {
  expect(maskValue('')).toBe('');
  expect(maskValue('ab')).toBe('••••••');
  expect(maskValue('x'.repeat(40))).toBe('••••••••••••');
});
