import { createHmac } from 'node:crypto';

/**
 * Test helpers for driving a real Better Auth instance through a password +
 * authenticator-app sign-in: an RFC 6238 code from the enrolment URI, and a
 * cookie jar that folds Set-Cookie headers into the next request.
 */

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
export function totpFromUri(uri: string, at = Date.now()): string {
  const secret = base32Decode(new URL(uri).searchParams.get('secret')!);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = createHmac('sha1', secret).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  const n = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, '0');
}

/** Fold Set-Cookie headers into a Cookie request header (name=value only). */
export function cookieJar(prev: string, headers: Headers): string {
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
