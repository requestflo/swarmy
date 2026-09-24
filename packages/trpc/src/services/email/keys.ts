/**
 * Credential material for the email service.
 *
 * SMTP passwords are DERIVED (HMAC under the controller vault key, per
 * credential id), never stored: the MTA only needs the bcrypt hash (stored
 * once, so the rendered pass table is stable), the app gets the plaintext in
 * its Docker secret, and the controller can re-derive it to submit API mail
 * AS that credential — so the MTA's own log attributes every message, and its
 * sender-domain rule applies to API mail too. The HTTP API key is derived the
 * same way (only its sha-256 is stored, for lookup), so an app's Docker
 * secrets can be re-created on any apply. Rotating = a new credential.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { SMTP_USER_DOMAIN } from './maddy';

export const API_KEY_PREFIX = 'sem_';

export function vaultKey(): string {
  const k = process.env.SWARMY_SECRET_KEY;
  if (!k) throw new Error('The email service needs SWARMY_SECRET_KEY (the controller vault key) to be set.');
  return k;
}

export function isVaultReady(): boolean {
  return Boolean(process.env.SWARMY_SECRET_KEY);
}

export function smtpPasswordFor(credentialId: string): string {
  return createHmac('sha256', `swarmy.email.smtp.v1:${vaultKey()}`).update(credentialId).digest('base64url').slice(0, 32);
}

/** The login the MTA presents to the controller's bounce hook. */
export function bounceHookPassword(): string {
  return createHmac('sha256', `swarmy.email.bounce.v1:${vaultKey()}`).update('maddy').digest('base64url').slice(0, 32);
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The credential's HTTP API key (derived like the SMTP password; looked up by its sha-256). */
export function apiKeyFor(credentialId: string): string {
  return `${API_KEY_PREFIX}${createHmac('sha256', `swarmy.email.api.v1:${vaultKey()}`).update(credentialId).digest('base64url').slice(0, 40)}`;
}

export function newApiKey(): string {
  return `${API_KEY_PREFIX}${randomBytes(24).toString('base64url')}`;
}

export function sha256(v: string): string {
  return createHash('sha256').update(v, 'utf8').digest('hex');
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** `X-Swarmy-Signature: t=<unix>,v1=<hex hmac(secret, t + "." + body)>` */
export function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return `t=${t},v1=${mac}`;
}

/** Credential name → SMTP username (`<name>@swarmy`). */
export function smtpUsernameFor(name: string): string {
  return `${name}@${SMTP_USER_DOMAIN}`;
}

export const CREDENTIAL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** The controller's own credential (invites, verification, alerts). */
export const SYSTEM_CREDENTIAL = 'swarmy-system';
