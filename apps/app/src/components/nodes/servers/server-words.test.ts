import { describe, expect, test } from 'bun:test';
import { agentSkewWords } from './server-words';

describe('agentSkewWords — the agent skew line in plain words', () => {
  test('in step or unknown says nothing', () => {
    expect(agentSkewWords({ agentSkew: null })).toBeNull();
    expect(agentSkewWords({})).toBeNull();
    expect(agentSkewWords({ agentSkew: { status: 'ok', versions: null } })).toBeNull();
  });

  test('behind counts the versions in words and offers the upgrade', () => {
    expect(agentSkewWords({ agentSkew: { status: 'behind', versions: 2 } })).toEqual({
      say: 'This server’s agent is two versions behind',
      word: 'Agent behind',
      tone: 'warn',
      upgrade: true,
    });
    expect(agentSkewWords({ agentSkew: { status: 'behind', versions: 1 } })?.say).toBe(
      'This server’s agent is one version behind',
    );
    expect(agentSkewWords({ agentSkew: { status: 'behind', versions: null } })?.say).toBe('This server’s agent is behind');
  });

  test('ahead and incompatible never offer the agent upgrade', () => {
    expect(agentSkewWords({ agentSkew: { status: 'ahead', versions: 1 } })).toMatchObject({ tone: 'info', upgrade: false });
    expect(agentSkewWords({ agentSkew: { status: 'incompatible', versions: null } })).toMatchObject({
      tone: 'bad',
      upgrade: false,
    });
  });
});
