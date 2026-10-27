import { describe, expect, it } from 'bun:test';
import { AGENT_CAPABILITY } from '@swarmy/core/protocol';
import { pickReadNode } from './backupDownload.node';

const NEW = ['snapshotLs', 'snapshotDump'];
const base = {
  hostNodeId: 'host',
  managerIds: ['m1', 'm2'],
  isOnline: (n: string) => n !== 'off',
  capabilities: (n: string) => (n === 'old' ? ['dbPitrWindow'] : NEW),
  cap: AGENT_CAPABILITY.snapshotDump,
};

describe('pickReadNode', () => {
  it('a node-path save is read only on the server that holds it', () => {
    expect(pickReadNode({ ...base, repoKind: 'node' })).toEqual({ nodeId: 'host' });
    expect(pickReadNode({ ...base, repoKind: 'node', hostNodeId: 'off' })).toMatchObject({ refuse: expect.stringContaining('offline') });
    expect(pickReadNode({ ...base, repoKind: 'node', hostNodeId: null })).toMatchObject({ refuse: expect.stringContaining('doesn’t know') });
    expect(pickReadNode({ ...base, repoKind: 'node', hostNodeId: 'old' })).toMatchObject({ refuse: expect.stringContaining('too old') });
  });

  it('an S3 save prefers the server that took it, then a manager', () => {
    expect(pickReadNode({ ...base, repoKind: 's3' })).toEqual({ nodeId: 'host' });
    expect(pickReadNode({ ...base, repoKind: 's3', hostNodeId: 'off' })).toEqual({ nodeId: 'm1' });
    expect(pickReadNode({ ...base, repoKind: 's3', hostNodeId: null })).toEqual({ nodeId: 'm1' });
  });

  it('skips agents that never advertised the capability (they would drop the frame)', () => {
    expect(pickReadNode({ ...base, repoKind: 's3', hostNodeId: 'old', managerIds: ['old', 'm2'] })).toEqual({ nodeId: 'm2' });
    expect(pickReadNode({ ...base, repoKind: 's3', hostNodeId: 'old', managerIds: ['old'] })).toMatchObject({ refuse: expect.stringContaining('too old') });
  });

  it('says so when nothing is online', () => {
    expect(pickReadNode({ ...base, repoKind: 's3', hostNodeId: 'off', managerIds: [] })).toEqual({ refuse: 'No server is online to read this save.' });
  });
});
