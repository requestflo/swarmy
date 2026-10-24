import { describe, expect, it } from 'bun:test';
import { PROTOCOL_VERSION } from '@swarmy/core/protocol';
import { judgeAgentSkew } from './agent-skew';

const facts = (agentVersion: string, protocolVersions: number[]) => ({ hostname: 'edge-1', agentVersion, protocolVersions });

describe('judgeAgentSkew (register-time skew)', () => {
  it('records behind with the distance and stays quiet', () => {
    const warned: string[] = [];
    const skew = judgeAgentSkew('n1', facts('1.2.0', [PROTOCOL_VERSION]), '1.4.0', (m) => warned.push(m));
    expect(skew).toEqual({ status: 'behind', versions: 2 });
    expect(warned).toEqual([]);
  });

  it('warns once when the agent shares no protocol version', () => {
    const warned: string[] = [];
    const skew = judgeAgentSkew('n1', facts('9.0.0', [PROTOCOL_VERSION + 1]), '1.4.0', (m) => warned.push(m));
    expect(skew.status).toBe('incompatible');
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('node n1 (edge-1)');
    expect(warned[0]).toContain('upgrade the agent');
  });

  it('a matching build is ok', () => {
    expect(judgeAgentSkew('n1', facts('1.4.0', [PROTOCOL_VERSION]), '1.4.0', () => {})).toEqual({
      status: 'ok',
      versions: null,
    });
  });
});
