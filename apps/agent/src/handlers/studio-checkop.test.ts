import { describe, expect, it } from 'bun:test';
import type { StudioOp } from '@swarmy/core/protocol';
import { checkOp } from './studio';

const redis = (argv: string[], access: 'read' | 'write' = 'write') =>
  checkOp({ engine: 'redis', op: { kind: 'redis', argv, access } as StudioOp });

describe('studio second wall: Redis argv', () => {
  it('refuses a command starting with "-" even in write mode (it would be a redis-cli option)', () => {
    expect(() => redis(['-h', 'evil.example', 'GET', 'k'])).toThrow('never starts with "-"');
    expect(() => redis(['--eval', '/tmp/x.lua'])).toThrow('never starts with "-"');
  });

  it('still runs ordinary commands, dashes in later arguments included', () => {
    expect(() => redis(['SET', 'counter', '-1'])).not.toThrow();
    expect(() => redis(['GET', '-k'], 'read')).not.toThrow();
  });
});
