import { describe, expect, test } from 'bun:test';
import {
  PEER_LOGIN_EXPIRY_DEFAULT_HOURS,
  loginExpiryHours,
  loginExpirySec,
  peopleLoginExpiryHours,
  planPeopleLoginExpiry,
} from './login-expiry';
import { applyPeopleLoginExpiry } from './control-plane/login-expiry-sync';
import type { NbPeerFull, NbUser } from './control-plane/netbird-admin';

describe('people login expiry defaults (plan §3.1, pick 3)', () => {
  test('12 h unless the org set a valid value; clamped to 1 h .. 30 d, whole hours', () => {
    expect(PEER_LOGIN_EXPIRY_DEFAULT_HOURS).toBe(12);
    expect(loginExpiryHours(undefined)).toBe(12);
    expect(loginExpiryHours('8')).toBe(12);
    expect(loginExpiryHours(0)).toBe(12);
    expect(loginExpiryHours(-3)).toBe(12);
    expect(loginExpiryHours(Number.NaN)).toBe(12);
    expect(loginExpiryHours(0.2)).toBe(1);
    expect(loginExpiryHours(8.4)).toBe(8);
    expect(loginExpiryHours(10_000)).toBe(720);
    expect(loginExpirySec(undefined)).toBe(43_200);
    expect(loginExpirySec(24)).toBe(86_400);
  });

  test('reads the org setting out of MeshConfig.settings', () => {
    expect(peopleLoginExpiryHours(null)).toBe(12);
    expect(peopleLoginExpiryHours({})).toBe(12);
    expect(peopleLoginExpiryHours({ peopleAccess: 'x' })).toBe(12);
    expect(peopleLoginExpiryHours({ peopleAccess: { enabled: true, loginExpiryHours: 4 } })).toBe(4);
  });

  test("only people's peers with expiry off are switched back on; servers and routers never", () => {
    const people = new Set(['u-alice']);
    const plan = planPeopleLoginExpiry(
      [
        { id: 'p3', name: 'alice-mac', userId: 'u-alice', sshEnabled: true, loginExpirationEnabled: false, inactivityExpirationEnabled: true },
        { id: 'p1', name: 'alice-phone', userId: 'u-alice', loginExpirationEnabled: false },
        { id: 'p2', name: 'alice-ok', userId: 'u-alice', loginExpirationEnabled: true },
        { id: 'p4', name: 'alice-old-server', userId: 'u-alice' },
        { id: 'p5', name: 'lon-1', userId: '', loginExpirationEnabled: false },
        { id: 'p6', name: 'router', userId: 'u-service', loginExpirationEnabled: false },
      ],
      people,
    );
    expect(plan).toEqual([
      { id: 'p1', name: 'alice-phone', ssh_enabled: false, login_expiration_enabled: true, inactivity_expiration_enabled: false },
      { id: 'p3', name: 'alice-mac', ssh_enabled: true, login_expiration_enabled: true, inactivity_expiration_enabled: true },
    ]);
  });

  test('the sync writes each lapsed person peer once, then nothing', async () => {
    const users: NbUser[] = [
      { id: 'u-alice', email: 'a@x', name: 'Alice', role: 'user', auto_groups: [], is_blocked: false },
      { id: 'u-svc', email: '', name: 'swarmy-controller', role: 'admin', auto_groups: [], is_blocked: false, is_service_user: true },
    ];
    const peers: NbPeerFull[] = [
      { id: 'p1', name: 'alice-mac', ip: '100.92.0.9', connected: true, user_id: 'u-alice', login_expiration_enabled: false, ssh_enabled: false, inactivity_expiration_enabled: false },
      { id: 'p2', name: 'lon-1', ip: '100.92.0.1', connected: true, user_id: 'u-svc', login_expiration_enabled: false },
    ];
    const writes: string[] = [];
    const api = {
      listUsers: async () => structuredClone(users),
      listPeersFull: async () => structuredClone(peers),
      updatePeer: async (id: string, b: { name: string; login_expiration_enabled: boolean }) => {
        writes.push(`${id} ${b.name} ${b.login_expiration_enabled}`);
        Object.assign(peers.find((p) => p.id === id)!, b);
        return peers.find((p) => p.id === id)!;
      },
    };
    expect((await applyPeopleLoginExpiry(api)).changes).toEqual([{ op: 'update', kind: 'peer', name: 'alice-mac' }]);
    expect(writes).toEqual(['p1 alice-mac true']);
    expect((await applyPeopleLoginExpiry(api)).changes).toEqual([]);
  });
});
