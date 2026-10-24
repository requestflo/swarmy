import type { BasicAuthUser, RouteProtection } from '@/components/ingress/protection-model';
import { patch } from './protection-rules';

/**
 * "Require a password" (HTTP basic auth on the route), over the route's real
 * protection model. A new password travels once, in the save; the controller
 * hashes and seals it and the label only ever names the user and where the
 * hash is kept.
 */

const USERNAME = /^[A-Za-z0-9._@+-]{1,64}$/;
export const MIN_PASSWORD = 8;

export function passwordUsers(p: RouteProtection | null): BasicAuthUser[] {
  return p?.basicAuth?.users ?? [];
}

export function isPasswordOn(p: RouteProtection | null): boolean {
  return passwordUsers(p).length > 0;
}

/** Add a person, or give a username that is already there a new password. */
export function withPasswordUser(p: RouteProtection | null, username: string, password: string): RouteProtection | null {
  const users = passwordUsers(p).filter((u) => u.username !== username);
  return patch(p, { basicAuth: { users: [...users, { username, password }] } });
}

/** Take one person off; the last one off turns the password off. */
export function withoutPasswordUser(p: RouteProtection | null, username: string): RouteProtection | null {
  const users = passwordUsers(p).filter((u) => u.username !== username);
  return patch(p, { basicAuth: users.length ? { users } : undefined });
}

export function passwordOff(p: RouteProtection | null): RouteProtection | null {
  return patch(p, { basicAuth: undefined });
}

/** Why a username + password can't be saved yet, in a sentence — or null. */
export function passwordProblem(username: string, password: string): string | null {
  if (!USERNAME.test(username.trim())) return 'A username is letters, digits or . _ @ + -, with no spaces.';
  if (password.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (password.length > 128) return 'Use 128 characters or fewer.';
  return null;
}

function names(users: BasicAuthUser[]): string {
  const xs = users.map((u) => u.username);
  if (xs.length <= 2) return xs.join(' or ');
  return `${xs.slice(0, 2).join(', ')} or ${xs.length - 2} more`;
}

/** What the card says. */
export function passwordSay(p: RouteProtection | null, service: string): string {
  const users = passwordUsers(p);
  if (!users.length) return `Anyone with the address reaches ${service}.`;
  return `Visitors sign in as ${names(users)} before they reach ${service}.`;
}
