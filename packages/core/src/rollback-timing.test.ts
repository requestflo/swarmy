import { describe, expect, it } from 'bun:test';
import { LastRollbackInput, rollbackSpanWords, rollbackTookSec } from './rollback-timing';

describe('rollbackTookSec', () => {
  it('rounds to whole seconds, never below one', () => {
    const start = new Date('2026-10-25T14:00:00.000Z');
    expect(rollbackTookSec(start, new Date('2026-10-25T14:00:41.400Z'))).toBe(41);
    expect(rollbackTookSec(start, new Date('2026-10-25T14:00:00.200Z'))).toBe(1);
    expect(rollbackTookSec(start, new Date('2026-10-25T13:59:59.000Z'))).toBe(1);
  });
});

describe('rollbackSpanWords', () => {
  it('says seconds, then minutes and seconds, then minutes', () => {
    expect(rollbackSpanWords(41)).toBe('41 s');
    expect(rollbackSpanWords(125)).toBe('2 min 5 s');
    expect(rollbackSpanWords(120)).toBe('2 min');
    expect(rollbackSpanWords(725)).toBe('12 min');
  });
});

describe('LastRollbackInput', () => {
  it('takes one app, or none for the whole estate', () => {
    expect(LastRollbackInput.parse(undefined)).toEqual({});
    expect(LastRollbackInput.parse({ stackName: 'shop' })).toEqual({ stackName: 'shop' });
    expect(LastRollbackInput.safeParse({ stackName: '' }).success).toBe(false);
  });
});
