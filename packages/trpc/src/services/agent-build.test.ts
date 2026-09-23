import { describe, expect, it } from 'bun:test';
import { isSameAgentBuild } from './node.service';

describe('isSameAgentBuild', () => {
  const release = { version: '0.0.0', commit: 'b6977ff0c0ffee' };
  it('two unreleased builds (both 0.0.0) differ by commit — the upgrade is not a no-op', () => {
    expect(isSameAgentBuild({ version: '0.0.0', commit: '18e5cc7aaaa' }, release)).toBe(false);
  });
  it('an agent that predates commit reporting is older by definition', () => {
    expect(isSameAgentBuild({ version: '0.0.0' }, release)).toBe(false);
  });
  it('same version + commit is up to date', () => {
    expect(isSameAgentBuild({ version: '0.0.0', commit: 'b6977ff0c0ffee' }, release)).toBe(true);
  });
  it('without a release commit (dev), falls back to the version', () => {
    expect(isSameAgentBuild({ version: '1.2.0', commit: 'dev' }, { version: '1.2.0' })).toBe(true);
    expect(isSameAgentBuild({ version: '1.1.0' }, { version: '1.2.0' })).toBe(false);
  });
});
