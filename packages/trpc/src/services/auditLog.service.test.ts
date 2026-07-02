import { describe, expect, it } from 'bun:test';
import type { AuditEntryView } from '@swarmy/core';
import {
  actorFallbackLabel,
  buildAuditWhere,
  csvEscape,
  parseRetentionDays,
  renderAuditCsv,
} from './auditLog.service';

function entry(over: Partial<AuditEntryView> = {}): AuditEntryView {
  return {
    id: '42',
    ts: '2026-07-01T12:00:00.000Z',
    actorType: 'user',
    actorId: 'u1',
    actorLabel: 'Calum Macrae',
    action: 'stack.deploy',
    targetType: 'stack',
    targetId: 'storefront',
    metadata: {},
    ...over,
  };
}

describe('csvEscape — RFC 4180 + formula-injection guard', () => {
  it('passes plain values through untouched', () => {
    expect(csvEscape('stack.deploy')).toBe('stack.deploy');
    expect(csvEscape('2026-07-01T12:00:00.000Z')).toBe('2026-07-01T12:00:00.000Z');
    expect(csvEscape('')).toBe('');
  });

  it('quotes values containing commas and newlines', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('line1\nline2')).toBe('"line1\nline2"');
    expect(csvEscape('cr\rlf')).toBe('"cr\rlf"');
  });

  it('doubles embedded quotes and wraps the cell', () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  it('neutralizes spreadsheet formula prefixes', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvEscape('+123')).toBe("'+123");
    expect(csvEscape('@cmd')).toBe("'@cmd");
    expect(csvEscape('\tx')).toBe("'\tx");
  });

  it('quotes a formula cell that also contains a comma', () => {
    expect(csvEscape('=1,2')).toBe('"\'=1,2"');
  });
});

describe('renderAuditCsv', () => {
  it('renders header + one CRLF-terminated line per entry', () => {
    const csv = renderAuditCsv([entry()]);
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('id,ts,actorType,actorId,actorLabel,action,targetType,targetId,metadata');
    expect(lines[1]).toBe(
      '42,2026-07-01T12:00:00.000Z,user,u1,Calum Macrae,stack.deploy,stack,storefront,{}',
    );
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('serializes metadata as escaped JSON and blanks nulls', () => {
    const csv = renderAuditCsv([
      entry({ metadata: { image: 'nginx:1.27', note: 'a,b' }, targetType: null, targetId: null }),
    ]);
    const row = csv.split('\r\n')[1]!;
    expect(row).toContain('"{""image"":""nginx:1.27"",""note"":""a,b""}"');
    expect(row).toContain(',stack.deploy,,,');
  });

  it('renders only the header for an empty export', () => {
    expect(renderAuditCsv([])).toBe(
      'id,ts,actorType,actorId,actorLabel,action,targetType,targetId,metadata\r\n',
    );
  });
});

describe('buildAuditWhere — filter → Prisma where', () => {
  it('always scopes to the org', () => {
    expect(buildAuditWhere('org-1', {})).toEqual({ orgId: 'org-1' });
  });

  it('maps actor / actorType / resource filters to columns', () => {
    expect(
      buildAuditWhere('org-1', {
        actor: 'u1',
        actorType: 'apikey',
        resourceType: 'stack',
        resourceId: 'storefront',
      }),
    ).toEqual({
      orgId: 'org-1',
      actorId: 'u1',
      actorType: 'apikey',
      targetType: 'stack',
      targetId: 'storefront',
    });
  });

  it('single action becomes a prefix match', () => {
    expect(buildAuditWhere('org-1', { action: 'secrets.' })).toEqual({
      orgId: 'org-1',
      action: { startsWith: 'secrets.' },
    });
  });

  it('multiple prefixes (canned questions) become an OR of startsWith', () => {
    expect(buildAuditWhere('org-1', { actions: ['terminal.', 'node.shell'] })).toEqual({
      orgId: 'org-1',
      OR: [{ action: { startsWith: 'terminal.' } }, { action: { startsWith: 'node.shell' } }],
    });
  });

  it('merges `action` into the prefix OR when both are given', () => {
    const where = buildAuditWhere('org-1', { action: 'backup.', actions: ['db.backup'] });
    expect(where.OR).toEqual([
      { action: { startsWith: 'db.backup' } },
      { action: { startsWith: 'backup.' } },
    ]);
  });

  it('maps from/to onto a ts range', () => {
    const where = buildAuditWhere('org-1', {
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-30T10:00:00.000Z',
    });
    expect(where.ts).toEqual({
      gte: new Date('2026-06-01T00:00:00.000Z'),
      lte: new Date('2026-06-30T10:00:00.000Z'),
    });
  });

  it('extends a bare date `to` through the end of that day (UTC)', () => {
    const where = buildAuditWhere('org-1', { to: '2026-06-30' });
    expect((where.ts as { lte: Date }).lte.toISOString()).toBe('2026-06-30T23:59:59.999Z');
  });

  it('ignores unparseable dates instead of throwing', () => {
    const where = buildAuditWhere('org-1', { from: 'not-a-date' });
    expect(where.ts).toBeUndefined();
  });
});

describe('parseRetentionDays — Organization.metadata override', () => {
  it('reads a valid integer override', () => {
    expect(parseRetentionDays(JSON.stringify({ auditRetentionDays: 90 }))).toBe(90);
  });

  it('returns null for missing/empty/foreign metadata', () => {
    expect(parseRetentionDays(null)).toBeNull();
    expect(parseRetentionDays(undefined)).toBeNull();
    expect(parseRetentionDays('')).toBeNull();
    expect(parseRetentionDays(JSON.stringify({ plan: 'pro' }))).toBeNull();
  });

  it('rejects out-of-range, fractional and non-numeric values', () => {
    expect(parseRetentionDays(JSON.stringify({ auditRetentionDays: 1 }))).toBeNull();
    expect(parseRetentionDays(JSON.stringify({ auditRetentionDays: 100000 }))).toBeNull();
    expect(parseRetentionDays(JSON.stringify({ auditRetentionDays: 30.5 }))).toBeNull();
    expect(parseRetentionDays(JSON.stringify({ auditRetentionDays: '90' }))).toBeNull();
  });

  it('survives unparseable metadata', () => {
    expect(parseRetentionDays('{nope')).toBeNull();
    expect(parseRetentionDays('[1,2]')).toBeNull();
  });
});

describe('actorFallbackLabel', () => {
  it('labels each actor kind', () => {
    expect(actorFallbackLabel('system', null)).toBe('swarmy');
    expect(actorFallbackLabel('agent', 'node-abcdef1234')).toBe('agent node-abcdef1234');
    expect(actorFallbackLabel('apikey', 'key_1234567890')).toBe('API key key_1234');
    expect(actorFallbackLabel('user', null)).toBe('unknown user');
  });
});
