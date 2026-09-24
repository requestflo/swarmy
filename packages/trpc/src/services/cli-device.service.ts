/**
 * `swarmy login` — the OAuth 2.0 Device Authorization Grant (RFC 8628) shape,
 * ending in an ordinary org-scoped API key.
 *
 *   CLI  → POST /api/cli/device/code   { client_name, scopes }        (public)
 *        ← { device_code, user_code, verification_uri(_complete), interval }
 *   user → opens /device?code=ABCD-EFGH in the dashboard (signed in), approves
 *   CLI  → POST /api/cli/device/token  { device_code }                (public, polled)
 *        ← authorization_pending … then { access_token: swk_…, scope }
 *
 * Why an API key and not a session: the CLI then speaks the public REST API
 * like every other client, through the ONE key→principal seam
 * (`apiKeyContext`), revocable in Settings → API keys.
 *
 * Pending requests live in controller memory only (10-minute TTL, capped):
 * a restart just means "run swarmy login again". Device codes are stored as
 * sha256 hashes; the minted key's plaintext sits here only between approval
 * and the CLI's next poll, and is handed out exactly once.
 */
import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { OrgContext } from '../context';
import { badRequest, notFound, policyDenied } from '../errors';
import { createApiKey, type ApiKeyScope } from './apiKeys.service';
import { writeAudit } from './audit.service';

export const DEVICE_CODE_TTL_MS = 10 * 60_000;
export const DEVICE_POLL_INTERVAL_S = 5;
const MAX_PENDING = 500;
/** RFC 8628 §6.1: a base-20 consonant alphabet — no vowels (no words), no look-alikes. */
const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ';

export const CLI_SCOPES = ['read', 'write', 'secrets.read'] as const satisfies readonly ApiKeyScope[];

type Status = 'pending' | 'approved' | 'denied';

interface PendingDevice {
  deviceHash: string;
  userCode: string;
  clientName: string;
  hostname: string | null;
  requested: ApiKeyScope[];
  createdAt: number;
  expiresAt: number;
  lastPollAt: number;
  status: Status;
  /** Plaintext key between approval and the next poll; then deleted. */
  key?: string;
  granted?: ApiKeyScope[];
  orgId?: string;
  approvedBy?: string;
}

const byDevice = new Map<string, PendingDevice>();
const byUserCode = new Map<string, string>();

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

function sweep(now = Date.now()): void {
  for (const [h, p] of byDevice) {
    if (p.expiresAt <= now) {
      byDevice.delete(h);
      byUserCode.delete(p.userCode);
    }
  }
}

/** `abcd-efgh` / `ABCDEFGH` → `ABCD-EFGH`. */
export function normalizeUserCode(raw: string): string {
  const c = raw.toUpperCase().replace(/[^A-Z]/g, '');
  return c.length === 8 ? `${c.slice(0, 4)}-${c.slice(4)}` : c;
}

function newUserCode(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

/** Requested scopes, normalised: known values only, `read` always included. */
export function normalizeScopes(raw: readonly string[] | undefined): ApiKeyScope[] {
  const known = new Set<string>(CLI_SCOPES);
  const set = new Set<ApiKeyScope>(['read']);
  for (const s of raw ?? []) if (known.has(s)) set.add(s as ApiKeyScope);
  return CLI_SCOPES.filter((s) => set.has(s));
}

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
}

export function startDeviceAuthorization(input: {
  clientName?: string;
  hostname?: string;
  scopes?: string[];
}): DeviceStart {
  const now = Date.now();
  sweep(now);
  if (byDevice.size >= MAX_PENDING) throw badRequest('too many pending logins — try again in a few minutes');
  const deviceCode = randomBytes(32).toString('base64url');
  let userCode = newUserCode();
  while (byUserCode.has(userCode)) userCode = newUserCode();
  const entry: PendingDevice = {
    deviceHash: sha(deviceCode),
    userCode,
    clientName: (input.clientName ?? 'swarmy CLI').slice(0, 60),
    hostname: input.hostname ? input.hostname.slice(0, 100) : null,
    requested: normalizeScopes(input.scopes),
    createdAt: now,
    expiresAt: now + DEVICE_CODE_TTL_MS,
    lastPollAt: 0,
    status: 'pending',
  };
  byDevice.set(entry.deviceHash, entry);
  byUserCode.set(userCode, entry.deviceHash);
  return { deviceCode, userCode, expiresIn: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S };
}

export type DevicePoll =
  | { status: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' }
  | { status: 'approved'; key: string; scopes: ApiKeyScope[] };

/** The CLI's poll. Returns the key once, then forgets the request. */
export function pollDeviceAuthorization(deviceCode: string, now = Date.now()): DevicePoll {
  const entry = byDevice.get(sha(deviceCode));
  if (!entry || entry.expiresAt <= now) {
    if (entry) {
      byDevice.delete(entry.deviceHash);
      byUserCode.delete(entry.userCode);
    }
    return { status: 'expired_token' };
  }
  if (entry.status === 'denied') {
    byDevice.delete(entry.deviceHash);
    byUserCode.delete(entry.userCode);
    return { status: 'access_denied' };
  }
  if (entry.status === 'approved' && entry.key) {
    const r = { status: 'approved' as const, key: entry.key, scopes: entry.granted ?? ['read'] };
    byDevice.delete(entry.deviceHash);
    byUserCode.delete(entry.userCode);
    return r;
  }
  // RFC 8628 §3.5: polling faster than the interval earns slow_down.
  const tooFast = entry.lastPollAt && now - entry.lastPollAt < (DEVICE_POLL_INTERVAL_S * 1000) / 2;
  entry.lastPollAt = now;
  return { status: tooFast ? 'slow_down' : 'authorization_pending' };
}

export interface DeviceRequestView {
  userCode: string;
  clientName: string;
  hostname: string | null;
  requestedScopes: ApiKeyScope[];
  /** Scopes this signed-in member may grant (members: read only). */
  grantableScopes: ApiKeyScope[];
  createdAt: string;
  expiresAt: string;
  status: Status;
}

function lookup(userCode: string): PendingDevice {
  sweep();
  const hash = byUserCode.get(normalizeUserCode(userCode));
  const entry = hash ? byDevice.get(hash) : undefined;
  if (!entry) throw notFound('login request', normalizeUserCode(userCode));
  return entry;
}

/**
 * Who may grant what. A member may approve a read-only key for themselves
 * (it can never exceed what they can already read). Keys that can change
 * things or read secrets need an admin/owner — the same bar as minting a key
 * in Settings → API keys.
 */
export function grantableScopes(role: OrgContext['membership']['role']): ApiKeyScope[] {
  return role === 'member' ? ['read'] : [...CLI_SCOPES];
}

export function describeDeviceAuthorization(ctx: OrgContext, userCode: string): DeviceRequestView {
  const e = lookup(userCode);
  return {
    userCode: e.userCode,
    clientName: e.clientName,
    hostname: e.hostname,
    requestedScopes: e.requested,
    grantableScopes: grantableScopes(ctx.membership.role),
    createdAt: new Date(e.createdAt).toISOString(),
    expiresAt: new Date(e.expiresAt).toISOString(),
    status: e.status,
  };
}

export async function approveDeviceAuthorization(
  ctx: OrgContext,
  input: { userCode: string; scopes?: string[] },
): Promise<{ userCode: string; scopes: ApiKeyScope[]; keyId: string }> {
  const e = lookup(input.userCode);
  if (e.status !== 'pending') throw badRequest(`this login request was already ${e.status}`);
  const scopes = normalizeScopes(input.scopes ?? e.requested).filter((s) => e.requested.includes(s));
  const allowed = grantableScopes(ctx.membership.role);
  const over = scopes.filter((s) => !allowed.includes(s));
  if (over.length) throw policyDenied(`grant ${over.join(', ')} to a CLI key (admin or owner only)`, null);
  const issued = await createApiKey(ctx, {
    name: `CLI · ${e.hostname ?? e.clientName}`.slice(0, 80),
    scopes,
  });
  e.status = 'approved';
  e.key = issued.key;
  e.granted = scopes;
  e.orgId = ctx.activeOrgId;
  e.approvedBy = ctx.user.id;
  await writeAudit(ctx, {
    action: 'cli.login.approve',
    targetType: 'apiKey',
    targetId: issued.id,
    metadata: { client: e.clientName, hostname: e.hostname, scopes },
  });
  return { userCode: e.userCode, scopes, keyId: issued.id };
}

export async function denyDeviceAuthorization(ctx: OrgContext, userCode: string): Promise<{ userCode: string; denied: true }> {
  const e = lookup(userCode);
  if (e.status === 'pending') e.status = 'denied';
  await writeAudit(ctx, {
    action: 'cli.login.deny',
    targetType: 'cliLogin',
    targetId: e.userCode,
    metadata: { client: e.clientName, hostname: e.hostname },
  });
  return { userCode: e.userCode, denied: true };
}

/** Test seam: forget every pending request. */
export function __resetDeviceAuthorizations(): void {
  byDevice.clear();
  byUserCode.clear();
}
