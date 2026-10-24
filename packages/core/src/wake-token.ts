/**
 * Signed scale-to-zero wake links.
 *
 * The edge routes a cold service's traffic to the controller's activator at
 * `/_wake/<service>/<token>`. The token is a short HMAC over org + service,
 * keyed by `SWARMY_SECRET_KEY`, so only a path swarmy rendered into an org's
 * edge config wakes anything. Nothing is stored: the same derivation renders
 * the path and verifies it. The token never reaches the visitor: the edge
 * rewrites internally and the activator 307s back to the original URL.
 *
 * With no `SWARMY_SECRET_KEY` (dev), a per-process random key signs instead.
 * That still works because the process that renders the edge config is the one
 * that verifies it, and a restart re-renders every cold route on its first
 * reconcile tick.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 22 base64url chars = 132 bits of the HMAC: short enough for a path, far past guessing. */
export const WAKE_TOKEN_LENGTH = 22;
export const WAKE_PATH_PREFIX = '/_wake';

let processKey: string | null = null;

function keyOf(secret: string | undefined): string {
  if (secret) return secret;
  processKey ??= randomBytes(32).toString('hex');
  return processKey;
}

/** The wake token for one org's service. Pure for a given secret. */
export function wakeToken(orgId: string, service: string, secret: string | undefined = process.env.SWARMY_SECRET_KEY): string {
  return createHmac('sha256', keyOf(secret))
    .update(`swarmy-wake-v1\n${orgId}\n${service}`)
    .digest('base64url')
    .slice(0, WAKE_TOKEN_LENGTH);
}

/** Constant-time check of a presented token against org + service. */
export function verifyWakeToken(
  orgId: string,
  service: string,
  token: string,
  secret: string | undefined = process.env.SWARMY_SECRET_KEY,
): boolean {
  if (token.length !== WAKE_TOKEN_LENGTH) return false;
  const want = Buffer.from(wakeToken(orgId, service, secret));
  const got = Buffer.from(token);
  return want.length === got.length && timingSafeEqual(want, got);
}

/** The activator path the edge renders for a cold service: `/_wake/<service>/<token>`. */
export function wakePathFor(orgId: string, service: string, secret: string | undefined = process.env.SWARMY_SECRET_KEY): string {
  return `${WAKE_PATH_PREFIX}/${encodeURIComponent(service)}/${wakeToken(orgId, service, secret)}`;
}
