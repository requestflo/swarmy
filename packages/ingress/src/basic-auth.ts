import { z } from 'zod';

/**
 * "Require a password" — HTTP basic auth as a route edge protection.
 *
 * Three shapes, so a password can never reach a Docker label:
 *  - the LABEL shape ({@link BasicAuthRuleSchema}, on `RouteProtection`) names
 *    each user and WHERE their bcrypt hash is sealed (`passwordSecret`, a
 *    reference into the controller's vault) — never a password, never a hash;
 *  - the WRITE shape ({@link BasicAuthUserInputSchema}) also accepts a new
 *    `password`, which the controller bcrypt-hashes and seals before the label
 *    is written (the plaintext exists only in that request);
 *  - the RENDER shape ({@link RouteBasicAuthSchema}, on `DomainRoute`) carries
 *    the resolved hashes, controller-computed at render time like `auth`/`rum`.
 *
 * Renderers emit the hashes only into the edge's own config (Caddy `basic_auth`,
 * written inside the edge task). An empty render user list means the hashes
 * could not be resolved: the route FAILS CLOSED rather than serving unprotected.
 */

export const BASIC_AUTH_MAX_USERS = 20;

/** Caddyfile-token-safe user names (no spaces, quotes or braces). */
export const BasicAuthUsernameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._@+-]{1,64}$/, 'a username is 1–64 letters, digits or . _ @ + -');

/** A vault reference (`rpw_<hex>`): what the label stores instead of a password. */
export const BasicAuthSecretRefSchema = z.string().regex(/^rpw_[a-f0-9]{16,64}$/, 'not a swarmy password reference');

/** bcrypt, as Go's x/crypto/bcrypt (Caddy) reads it. */
export const BCRYPT_HASH_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export const BasicAuthUserSchema = z.object({
  username: BasicAuthUsernameSchema,
  passwordSecret: BasicAuthSecretRefSchema,
});
export type BasicAuthUser = z.infer<typeof BasicAuthUserSchema>;

const uniqueNames = (r: { users: Array<{ username: string }> }) => new Set(r.users.map((u) => u.username)).size === r.users.length;
const UNIQUE = { message: 'each username can appear once' };

/** The label shape on `RouteProtection.basicAuth`. */
export const BasicAuthRuleSchema = z
  .object({ users: z.array(BasicAuthUserSchema).min(1).max(BASIC_AUTH_MAX_USERS) })
  .refine(uniqueNames, UNIQUE);
export type BasicAuthRule = z.infer<typeof BasicAuthRuleSchema>;

/** One user as a write carries it: a new `password`, or the reference already stored. */
export const BasicAuthUserInputSchema = z
  .object({
    username: BasicAuthUsernameSchema,
    passwordSecret: BasicAuthSecretRefSchema.optional(),
    password: z.string().min(8, 'a password is at least 8 characters').max(128).optional(),
  })
  .refine((u) => Boolean(u.password) !== Boolean(u.passwordSecret), {
    message: 'each user needs either a new password or its stored one',
  });
export type BasicAuthUserInput = z.infer<typeof BasicAuthUserInputSchema>;

export const BasicAuthRuleInputSchema = z
  .object({ users: z.array(BasicAuthUserInputSchema).min(1).max(BASIC_AUTH_MAX_USERS) })
  .refine(uniqueNames, UNIQUE);
export type BasicAuthRuleInput = z.infer<typeof BasicAuthRuleInputSchema>;

/** The render shape on `DomainRoute.basicAuth` (resolved hashes; empty = fail closed). */
export const RouteBasicAuthSchema = z.object({
  users: z
    .array(z.object({ username: BasicAuthUsernameSchema, hash: z.string().regex(BCRYPT_HASH_RE) }))
    .max(BASIC_AUTH_MAX_USERS),
});
export type RouteBasicAuth = z.infer<typeof RouteBasicAuthSchema>;

/** What a password route answers while its hashes cannot be resolved. */
export const BASIC_AUTH_UNAVAILABLE = 'respond "This address needs a password that is not set up yet" 503';

/**
 * Caddy lines for one route's password gate. Go's bcrypt reads `$2a$`/`$2b$`
 * alike; hashes are emitted as stored. No users ⇒ refuse every request.
 */
export function caddyBasicAuthLines(b: RouteBasicAuth): string[] {
  const seen = new Set<string>();
  const users = b.users.filter((u) => BCRYPT_HASH_RE.test(u.hash) && !seen.has(u.username) && Boolean(seen.add(u.username)));
  if (users.length === 0) return [BASIC_AUTH_UNAVAILABLE];
  return ['basic_auth {', ...users.map((u) => `  ${u.username} ${u.hash}`), '}'];
}

/** Hide bcrypt hashes in a rendered config shown to people (the preview). */
export function redactBcryptHashes(text: string): string {
  return text.replace(/\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}/g, '<bcrypt hash, sealed in swarmy>');
}
