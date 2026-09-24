import { describe, expect, test } from 'bun:test';
import { ApplyAccessRouterMsg, ApplyMeshControlMsg, MeshStatePayload } from './mesh';

describe('applyMeshControl / applyAccessRouter wire shapes', () => {
  test('applyMeshControl round-trips and defaults', () => {
    const msg = {
      type: 'applyMeshControl' as const,
      payload: {
        commandId: '11111111-1111-4111-8111-111111111111',
        spec: { image: 'netbirdio/netbird-server:0.79.0', configYaml: '{"server":{}}' },
      },
    };
    const parsed = ApplyMeshControlMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(parsed.payload.action).toBe('apply');
    expect(parsed.payload.spec).toEqual({ image: 'netbirdio/netbird-server:0.79.0', configYaml: '{"server":{}}', env: {}, litestream: null });
    expect(ApplyMeshControlMsg.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test('applyAccessRouter round-trips; unknown actions are rejected', () => {
    const parsed = ApplyAccessRouterMsg.parse({ type: 'applyAccessRouter', payload: { commandId: '22222222-2222-4222-8222-222222222222', stackId: 's1', network: 'storefront_default' } });
    expect(parsed.payload).toEqual({ commandId: '22222222-2222-4222-8222-222222222222', stackId: 's1', network: 'storefront_default', action: 'up', resolve: [] });
    expect(() => ApplyAccessRouterMsg.parse({ type: 'applyAccessRouter', payload: { commandId: '33333333-3333-4333-8333-333333333333', stackId: 's', network: 'n', action: 'nuke' } })).toThrow();
  });

  test('meshState carries the control-plane status (optional, older agents omit it)', () => {
    const base = { driver: 'netbird', connected: true, sampledAt: 1 };
    expect(MeshStatePayload.parse(base).control).toBeUndefined();
    const withCp = MeshStatePayload.parse({ ...base, control: { running: true, healthy: true, litestream: { running: true } } });
    expect(withCp.control).toEqual({ running: true, healthy: true, waitingForConfig: false, litestream: { running: true } });
  });
});
