/**
 * Peer login expiry for people on the mesh (plans/epic-self-hosted-mesh-and-
 * fleets.md §3.1, §11.8 pick 3: 12 h). Pure.
 *
 * NetBird applies its account-wide `peer_login_expiration` only to peers a
 * person added through an SSO login: setup-key peers (servers, access
 * routers) never expire, so the swarm can't drop off at the expiry. A
 * person's device must sign in again (through swarmy) when it lapses, so a
 * disabled account or a lost group falls off at the latest then, even if the
 * 30 s people sync were down.
 *
 * Two floors keep that true:
 *  - the account setting is converged to the org's hours on every bootstrap
 *    (it used to be reset to 12 h there, undoing the org's own setting);
 *  - a person's peer whose own `login_expiration_enabled` was switched off
 *    (by hand, through the NetBird API) is switched back on.
 */

export const PEER_LOGIN_EXPIRY_DEFAULT_HOURS = 12;
export const PEER_LOGIN_EXPIRY_MIN_HOURS = 1;
/** swarmy's bound (30 days); NetBird itself accepts up to 180 days. */
export const PEER_LOGIN_EXPIRY_MAX_HOURS = 30 * 24;

/** A valid hours value, clamped and whole; anything else is the default. */
export function loginExpiryHours(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return PEER_LOGIN_EXPIRY_DEFAULT_HOURS;
  return Math.min(PEER_LOGIN_EXPIRY_MAX_HOURS, Math.max(PEER_LOGIN_EXPIRY_MIN_HOURS, Math.round(raw)));
}

/** The hours an org set (`MeshConfig.settings.peopleAccess.loginExpiryHours`), or the default. */
export function peopleLoginExpiryHours(settings: Record<string, unknown> | null | undefined): number {
  const people = settings?.peopleAccess;
  return loginExpiryHours(people && typeof people === 'object' ? (people as Record<string, unknown>).loginExpiryHours : undefined);
}

/** NetBird's `peer_login_expiration` (seconds) for `hours`. */
export function loginExpirySec(hours: unknown): number {
  return loginExpiryHours(hours) * 3600;
}

/** What the people sync needs to know about one NetBird peer. */
export interface PeerExpiryFacts {
  id: string;
  name: string;
  /** The NetBird user who added it (empty for a setup-key peer). */
  userId?: string;
  sshEnabled?: boolean;
  /** Absent on a server that doesn't report it: never written then. */
  loginExpirationEnabled?: boolean;
  inactivityExpirationEnabled?: boolean;
}

/** The body of NetBird's `PUT /api/peers/{id}` (every required field). */
export interface PeerExpiryUpdate {
  id: string;
  name: string;
  ssh_enabled: boolean;
  login_expiration_enabled: boolean;
  inactivity_expiration_enabled: boolean;
}

/**
 * People's peers whose login expiry is off, to switch back on. Only peers of
 * `peopleUserIds` (NetBird users who are people, not service users) are
 * touched; servers and routers are left exactly as they are. Everything else
 * on the peer is sent back unchanged. Sorted by id.
 */
export function planPeopleLoginExpiry(peers: readonly PeerExpiryFacts[], peopleUserIds: ReadonlySet<string>): PeerExpiryUpdate[] {
  return peers
    .filter((p) => p.userId && peopleUserIds.has(p.userId) && p.loginExpirationEnabled === false)
    .map((p) => ({
      id: p.id,
      name: p.name,
      ssh_enabled: p.sshEnabled ?? false,
      login_expiration_enabled: true,
      inactivity_expiration_enabled: p.inactivityExpirationEnabled ?? false,
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
