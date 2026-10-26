import { describe, expect, it } from 'bun:test';
import { tripNote } from './release-label';

describe('tripNote', () => {
  it('shows what the error trip wrote, and nothing else', () => {
    expect(tripNote({ notes: 'Stopped: 7% of requests failed, up from 0.4%' })).toBe('Stopped: 7% of requests failed, up from 0.4%');
    expect(tripNote({ notes: 'Failed: 12% of requests failed, above the 2% line' })).toBe('Failed: 12% of requests failed, above the 2% line');
    expect(tripNote({ notes: 'Health gate failed: degraded' })).toBeNull();
    expect(tripNote({ notes: 'Automatic rollback to release r1' })).toBeNull();
    expect(tripNote({ notes: null })).toBeNull();
  });
});
