import { describe, expect, it } from 'bun:test';
import { commandTimeoutMs } from './hub';

describe('commandTimeoutMs', () => {
  it('uses the per-command default instead of a flat 15s', () => {
    expect(commandTimeoutMs('updateAgent')).toBe(300_000);
    expect(commandTimeoutMs('deployService')).toBe(120_000);
    expect(commandTimeoutMs('pullImage')).toBe(600_000);
  });
  it('an explicit timeout wins; unknown commands fall back to 15s', () => {
    expect(commandTimeoutMs('updateAgent', 5_000)).toBe(5_000);
    expect(commandTimeoutMs('somethingNew')).toBe(15_000);
  });
  it('0 means no deadline (never an immediate reject)', () => {
    expect(commandTimeoutMs('streamLogs')).toBeGreaterThan(1_000_000_000);
  });
});
