import { describe, expect, it } from 'bun:test';
import { pickCommandId } from './command-id';

describe('pickCommandId', () => {
  it('honours a caller-supplied commandId (build logsRef keys the log bus)', () => {
    expect(pickCommandId({ commandId: 'build-log-ref' }, () => false)).toBe('build-log-ref');
  });

  it('mints a fresh id when none is supplied', () => {
    const id = pickCommandId({ spec: {} }, () => false);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('mints a fresh id when the supplied one is already in flight', () => {
    const id = pickCommandId({ commandId: 'dup' }, (x) => x === 'dup');
    expect(id).not.toBe('dup');
  });

  it('ignores non-string ids', () => {
    expect(pickCommandId({ commandId: 42 }, () => false)).not.toBe(42 as unknown as string);
    expect(pickCommandId(undefined, () => false)).toMatch(/^[0-9a-f-]{36}$/);
  });
});
