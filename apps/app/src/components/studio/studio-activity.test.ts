import { describe, expect, test } from 'bun:test';
import type { AuditEntryView } from '@swarmy/core';
import { studioActivity } from './studio-activity';

const entry = (id: string, actorLabel: string, metadata: Record<string, unknown>, action = 'studio.query'): AuditEntryView => ({
  id,
  ts: new Date().toISOString(),
  actorType: 'user',
  actorId: `u-${actorLabel}`,
  actorLabel,
  action,
  targetType: 'database',
  targetId: 'storefront/db',
  metadata,
});

describe('studioActivity', () => {
  test('keeps what people ran and says it plainly', () => {
    const lines = studioActivity([
      entry('5', 'Ava Chen', { origin: 'saved', class: 'read', status: 'ok', rows: 7, durationMs: 38, statement: 'SELECT 1' }),
      entry('4', 'Ava Chen', { origin: 'browse', class: 'read', status: 'ok', rows: 50 }),
      entry('3', 'Marco Ruiz', { origin: 'edit', class: 'write', status: 'ok', affected: 1, durationMs: 12 }),
      entry('2', 'Demo Pilot', { origin: 'console', class: 'read', status: 'failed', error: 'timeout' }),
      entry('1', 'Demo Pilot', { origin: 'console', class: 'read', status: 'ok' }, 'studio.savedQuery.save'),
    ]);
    expect(lines.map((l) => `${l.who} ${l.what} · ${l.detail}`)).toEqual([
      'Ava Chen ran a saved query · 7 rows · 38 ms',
      'Marco Ruiz edited a row · 1 row changed · 12 ms',
      'Demo Pilot ran a read · failed',
    ]);
    expect(lines[0]!.statement).toBe('SELECT 1');
    expect(lines[2]!.failed).toBe(true);
  });

  test('stops at the limit', () => {
    const many = Array.from({ length: 6 }, (_, i) => entry(String(i), 'Ava', { origin: 'console', class: 'read', status: 'ok', rows: i }));
    expect(studioActivity(many, 2)).toHaveLength(2);
  });
});
