import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { ensureSchema, PrismaClient, PrismaPGlite, type DB } from '@swarmy/db';
import { buildAuth } from './server';
import { classifySessionPath, nextStepUpCounters, STEP_UP_LOCKOUT } from './two-factor';

describe('classifySessionPath', () => {
  it('treats a code verify (and passkey sign-in) as MFA-verified', () => {
    expect(classifySessionPath('/two-factor/verify-totp')).toBe('verified');
    expect(classifySessionPath('/two-factor/verify-backup-code')).toBe('verified');
    expect(classifySessionPath('/sign-in/passkey')).toBe('verified');
  });
  it('marks sign-ins that skip the plugin challenge as pending', () => {
    expect(classifySessionPath('/magic-link/verify')).toBe('pending');
    expect(classifySessionPath('/callback/:id')).toBe('pending');
    expect(classifySessionPath('/sign-in/social')).toBe('pending');
  });
  it('exempts org SSO (the IdP owns MFA)', () => {
    expect(classifySessionPath('/oauth2/callback/:providerId')).toBe('exempt');
  });
  it('leaves password sign-in (plugin-challenged) and rotations alone', () => {
    expect(classifySessionPath('/sign-in/email')).toBe('none');
    expect(classifySessionPath('/change-password')).toBe('none');
    expect(classifySessionPath(undefined)).toBe('none');
  });
});

describe('nextStepUpCounters', () => {
  const now = new Date('2026-09-24T12:00:00Z');
  it('counts failures and locks at the budget', () => {
    expect(nextStepUpCounters({ failedVerificationCount: 0 }, false, now)).toEqual({
      failedVerificationCount: 1,
      lockedUntil: null,
    });
    const locked = nextStepUpCounters(
      { failedVerificationCount: STEP_UP_LOCKOUT.maxFailedAttempts - 1 },
      false,
      now,
    );
    expect(locked?.lockedUntil?.getTime()).toBe(now.getTime() + STEP_UP_LOCKOUT.durationMs);
  });
  it('resets on success, and writes nothing when already clean', () => {
    expect(nextStepUpCounters({ failedVerificationCount: 3 }, true, now)).toEqual({
      failedVerificationCount: 0,
      lockedUntil: null,
    });
    expect(nextStepUpCounters({ failedVerificationCount: 0 }, true, now)).toBeNull();
  });
});

// ── End to end against an in-memory Postgres (PGlite + the real migrations) ──

function base32Decode(s: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30s) from an otpauth:// URI. */
function totpFromUri(uri: string, at = Date.now()): string {
  const secret = base32Decode(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Fold Set-Cookie headers into a Cookie request header (name=value only). */
function cookieJar(prev: string, headers: Headers): string {
  const jar = new Map(
    prev
      .split('; ')
      .filter(Boolean)
      .map((kv) => [kv.split('=')[0]!, kv] as const),
  );
  for (const sc of headers.getSetCookie()) {
    const kv = sc.split(';')[0]!;
    const name = kv.split('=')[0]!;
    if (/max-age=0/i.test(sc) || kv.endsWith('=')) jar.delete(name);
    else jar.set(name, kv);
  }
  return [...jar.values()].join('; ');
}

describe('twoFactor end to end', () => {
  let db: DB;
  let auth: ReturnType<typeof buildAuth>;
  const links: string[] = [];
  const email = 'owner@example.com';
  const password = 'correct-horse-battery';
  let totpURI = '';
  let backupCodes: string[] = [];

  beforeAll(async () => {
    process.env.BETTER_AUTH_SECRET ??= 'test-secret-test-secret-test-secret-000';
    process.env.SWARMY_AUTH_RATE_LIMIT = '0';
    // keepOpen: ensureSchema's dispose must not close the shared in-memory DB.
    const factory = new PrismaPGlite({ keepOpen: true });
    await ensureSchema(factory);
    db = new PrismaClient({ adapter: factory }) as unknown as DB;
    auth = buildAuth(
      { social: {}, magicLink: true },
      { db, sendMagicLink: async ({ token }) => void links.push(token) },
    );
  }, 60_000);

  afterAll(async () => {
    await (db as unknown as { $disconnect(): Promise<void> }).$disconnect();
  });

  async function sessionRow(cookie: string) {
    const s = await auth.api.getSession({ headers: new Headers({ cookie }) });
    return db.session.findUnique({ where: { id: s!.session.id } });
  }

  it('enrols: enable returns a URI + 10 backup codes; verify turns 2FA on and marks the session', async () => {
    const up = await auth.api.signUpEmail({ body: { email, password, name: 'Owner' }, returnHeaders: true });
    let cookie = cookieJar('', up.headers);
    const en = await auth.api.enableTwoFactor({ body: { password }, headers: new Headers({ cookie }) });
    totpURI = en.totpURI;
    backupCodes = en.backupCodes;
    expect(totpURI).toStartWith('otpauth://totp/');
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes[0]).toMatch(/^[A-Za-z0-9]{5}-[A-Za-z0-9]{5}$/);

    // Stored encrypted, never as the plain JSON list.
    const tf = await db.twoFactor.findFirst({ where: { user: { email } } });
    expect(tf?.backupCodes).not.toContain(backupCodes[0]!);

    const v = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpURI) },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    cookie = cookieJar(cookie, v.headers);
    const user = await db.user.findUnique({ where: { email } });
    expect(user?.twoFactorEnabled).toBe(true);
    expect((await sessionRow(cookie))?.mfaVerifiedAt).toBeInstanceOf(Date);
  });

  it('challenges a password sign-in, then the code mints an MFA-verified session', async () => {
    const res = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    expect((res.response as { twoFactorRedirect?: boolean }).twoFactorRedirect).toBe(true);
    let cookie = cookieJar('', res.headers);
    const v = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpURI) },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    cookie = cookieJar(cookie, v.headers);
    const row = await sessionRow(cookie);
    expect(row?.mfaVerifiedAt).toBeInstanceOf(Date);
    expect(row?.mfaPending).toBe(false);
  });

  it('marks a magic-link session pending until an in-session code clears it', async () => {
    // Better Auth drops the password account of an UNVERIFIED email on a
    // magic-link sign-in (pre-registration takeover guard); a real owner is verified.
    await db.user.update({ where: { email }, data: { emailVerified: true } });
    // magicLink is a runtime-optional plugin, so `Auth` does not infer its API.
    const api = auth.api as unknown as {
      signInMagicLink(a: { body: { email: string }; headers: Headers }): Promise<unknown>;
      magicLinkVerify(a: { query: { token: string }; headers: Headers; returnHeaders: true }): Promise<{
        headers: Headers;
      }>;
    };
    await api.signInMagicLink({ body: { email }, headers: new Headers() });
    const token = links.at(-1)!;
    const v = await api.magicLinkVerify({ query: { token }, headers: new Headers(), returnHeaders: true });
    let cookie = cookieJar('', v.headers);
    let row = await sessionRow(cookie);
    expect(row?.mfaPending).toBe(true);
    expect(row?.mfaVerifiedAt).toBeNull();

    const step = await auth.api.verifyBackupCode({
      body: { code: backupCodes[0]! },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    cookie = cookieJar(cookie, step.headers);
    row = await sessionRow(cookie);
    expect(row?.mfaPending).toBe(false);
    expect(row?.mfaVerifiedAt).toBeInstanceOf(Date);
  });

  it('locks in-session step-up after repeated wrong codes', async () => {
    const res = await auth.api.signInEmail({ body: { email, password }, returnHeaders: true });
    let cookie = cookieJar('', res.headers);
    const v = await auth.api.verifyTOTP({
      body: { code: totpFromUri(totpURI) },
      headers: new Headers({ cookie }),
      returnHeaders: true,
    });
    cookie = cookieJar(cookie, v.headers);
    const headers = new Headers({ cookie });
    const good = totpFromUri(totpURI);
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 0; i < STEP_UP_LOCKOUT.maxFailedAttempts; i++) {
      await expect(auth.api.verifyTOTP({ body: { code: wrong }, headers })).rejects.toThrow();
    }
    await expect(auth.api.verifyTOTP({ body: { code: good }, headers })).rejects.toThrow(/Too many/);
  });
});
