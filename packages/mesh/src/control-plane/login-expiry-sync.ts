/**
 * Keep people's devices on login expiry (see `login-expiry.ts` for why). One
 * pass over NetBird's users and peers: a person's peer with its own expiry
 * switched off gets it back on. Servers and routers (setup-key peers, or a
 * service user's) are never written. Idempotent: a second pass writes nothing.
 */
import type { NetbirdAdminApi } from './netbird-admin';
import type { SyncChange } from './people-sync';
import { planPeopleLoginExpiry } from '../login-expiry';

export async function applyPeopleLoginExpiry(
  api: Pick<NetbirdAdminApi, 'listUsers' | 'listPeersFull' | 'updatePeer'>,
): Promise<{ changes: SyncChange[] }> {
  const [users, peers] = await Promise.all([api.listUsers(), api.listPeersFull()]);
  const people = new Set(users.filter((u) => !u.is_service_user).map((u) => u.id));
  const updates = planPeopleLoginExpiry(
    peers.map((p) => ({
      id: p.id,
      name: p.name,
      userId: p.user_id,
      sshEnabled: p.ssh_enabled,
      loginExpirationEnabled: p.login_expiration_enabled,
      inactivityExpirationEnabled: p.inactivity_expiration_enabled,
    })),
    people,
  );
  const changes: SyncChange[] = [];
  for (const { id, ...body } of updates) {
    await api.updatePeer(id, body);
    changes.push({ op: 'update', kind: 'peer', name: body.name });
  }
  return { changes };
}
