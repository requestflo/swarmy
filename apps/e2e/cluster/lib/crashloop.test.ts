import { describe, expect, it } from 'bun:test';
import { failedAttempts } from './crashloop';

describe('crash-loop detection reads failed attempts off `docker service ps`', () => {
  it('counts Failed and Rejected tasks, not the one still starting or running', () => {
    // The umami shape from the nightly: a new attempt preparing, four behind it failed.
    const ps = [
      'Preparing 19 seconds ago',
      'Failed 19 seconds ago',
      'Failed 51 seconds ago',
      'Failed 2 minutes ago',
      'Rejected 3 minutes ago',
      'Shutdown 12 minutes ago',
      'Running 10 minutes ago',
      '',
    ].join('\n');
    expect(failedAttempts(ps)).toBe(4);
  });

  it('a healthy or freshly started service has none', () => {
    expect(failedAttempts('Running 4 seconds ago\nShutdown 2 minutes ago')).toBe(0);
    expect(failedAttempts('')).toBe(0);
  });
});
