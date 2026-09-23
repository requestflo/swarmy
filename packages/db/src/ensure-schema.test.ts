import { describe, expect, it } from 'bun:test';
import { stripSqlComments } from './ensure-schema';

describe('stripSqlComments', () => {
  it('removes a comment containing ";" so the adapter never splits inside it', () => {
    const sql = '-- delegation pinning, serial); DnsRecord is REPURPOSED\nCREATE TABLE "a" ("id" TEXT);';
    expect(stripSqlComments(sql).trim()).toBe('CREATE TABLE "a" ("id" TEXT);');
  });

  it('keeps comment-looking text inside quoted strings and identifiers', () => {
    const sql = `INSERT INTO "t--x" VALUES ('a -- b; c', 'it''s /* not */ a comment');`;
    expect(stripSqlComments(sql)).toBe(sql);
  });

  it('removes block comments', () => {
    expect(stripSqlComments('SELECT 1; /* x; y */ SELECT 2;')).toBe('SELECT 1;  SELECT 2;');
  });
});
