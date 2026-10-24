import { describe, expect, test } from 'bun:test';
import { ApplyAccessRouterMsg, ApplyMeshMsg } from './mesh';
import { parseControllerEnvelope } from './messages';

const MIRROR = 'localhost:5000/swarmy-system/ghcr.io/netbirdio/netbird@sha256:' + 'a'.repeat(64);
const AUTH = { username: 'swarmy', password: 'p', server: 'localhost:5000' };
const rendered = { driver: 'netbird', client: { kind: 'netbird', image: 'ghcr.io/netbirdio/netbird:0.79.0' } };

describe('mesh client image hints (M3 client mirror, additive)', () => {
  test('applyMesh without a hint parses exactly as before', () => {
    const p = ApplyMeshMsg.parse({ type: 'applyMesh', payload: { commandId: '11111111-1111-4111-8111-111111111111', rendered } }).payload;
    expect(p.mirrorImage).toBeUndefined();
    expect(p.registryAuth).toBeUndefined();
    expect(p.rendered.client?.image).toBe('ghcr.io/netbirdio/netbird:0.79.0');
  });

  test('applyMesh carries the mirror ref + its login next to the untouched upstream image', () => {
    const msg = { type: 'applyMesh' as const, payload: { commandId: '11111111-1111-4111-8111-111111111111', rendered, mirrorImage: MIRROR, registryAuth: AUTH } };
    const parsed = ApplyMeshMsg.parse(JSON.parse(JSON.stringify(msg)));
    expect(parsed.payload.mirrorImage).toBe(MIRROR);
    expect(parsed.payload.registryAuth).toEqual(AUTH);
    expect(parsed.payload.rendered.client?.image).toBe('ghcr.io/netbirdio/netbird:0.79.0');
    expect(ApplyMeshMsg.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test('applyAccessRouter takes the same optional hint; a bad login is rejected', () => {
    const base = { commandId: '22222222-2222-4222-8222-222222222222', stackId: 's1', network: 'shop_default' };
    expect(ApplyAccessRouterMsg.parse({ type: 'applyAccessRouter', payload: { ...base, mirrorImage: MIRROR } }).payload.mirrorImage).toBe(MIRROR);
    expect(ApplyAccessRouterMsg.safeParse({ type: 'applyAccessRouter', payload: { ...base, registryAuth: { username: 'x' } } }).success).toBe(false);
    expect(ApplyAccessRouterMsg.safeParse({ type: 'applyMesh', payload: base }).success).toBe(false);
  });

  test('the controller envelope still routes applyMesh with the hint', () => {
    const env = parseControllerEnvelope({
      v: 1,
      id: '33333333-3333-4333-8333-333333333333',
      ts: 1,
      type: 'applyMesh',
      payload: { commandId: '11111111-1111-4111-8111-111111111111', rendered, mirrorImage: MIRROR },
    });
    expect(env.type).toBe('applyMesh');
    expect(env.type === 'applyMesh' && env.payload.mirrorImage).toBe(MIRROR);
  });
});
