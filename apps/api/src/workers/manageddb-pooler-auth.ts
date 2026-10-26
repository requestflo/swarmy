import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * The pooler's own login (manageddb-pooler-boot.ts): a fresh random password
 * for its Docker secret, and the SCRAM-SHA-256 verifier the writer stores for
 * it. Only the verifier ever leaves the controller towards the writer (`$1`
 * of the role script); it proves nothing without the password, and Postgres
 * stores exactly this in pg_authid. Unit-tested against RFC 7677.
 */

/** 32 URL-safe characters: nothing to escape in a userlist or a libpq URL. */
export function poolerPassword(): string {
  return randomBytes(32).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, '0');
}

const hmac = (key: Buffer, msg: string): Buffer => createHmac('sha256', key).update(msg).digest();

export interface ScramKeys {
  storedKey: Buffer;
  serverKey: Buffer;
}

/** RFC 5802 keys for `password` (ASCII, so SASLprep is the identity). */
export function scramKeys(password: string, salt: Buffer, iterations: number): ScramKeys {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  return {
    storedKey: createHash('sha256').update(hmac(salted, 'Client Key')).digest(),
    serverKey: hmac(salted, 'Server Key'),
  };
}

/** `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`, the form `ALTER ROLE … PASSWORD` stores as-is. */
export function scramVerifier(password: string, salt: Buffer = randomBytes(16), iterations = 4096): string {
  const k = scramKeys(password, salt, iterations);
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${k.storedKey.toString('base64')}:${k.serverKey.toString('base64')}`;
}
