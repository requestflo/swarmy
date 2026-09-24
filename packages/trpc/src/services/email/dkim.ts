/**
 * DKIM (RFC 6376) — key generation, the DNS record value, signing and
 * verification. Pure over `node:crypto`; no network (verification takes the
 * public key, or a TXT lookup the caller supplies).
 *
 * The MTA (maddy) signs everything that leaves the cluster with the domain's
 * key; this module exists so the controller can mint keys, publish the exact
 * `<selector>._domainkey` record, and prove end to end (tests, the e2e run and
 * the Email page's test send) that what arrives verifies against DNS.
 *
 * Only `rsa-sha256` with relaxed/relaxed or simple canonicalization — what
 * maddy emits and every receiver accepts. Oversigned header names (listed more
 * than once in `h=`, as maddy does to stop header injection) are handled per
 * §5.4.2: each occurrence consumes the next instance from the bottom, and a
 * name with no instance left contributes nothing.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';

export const DKIM_DEFAULT_SELECTOR = 'swarmy';

export interface DkimKeyPair {
  /** PKCS#8 PEM — vault-encrypted at rest, a Docker secret on the MTA. */
  privateKeyPem: string;
  /** Base64 SubjectPublicKeyInfo (DER), the `p=` of the DNS record. */
  publicKeyB64: string;
}

/** A fresh 2048-bit RSA DKIM key (1024 is weak; 4096 overflows many UDP answers). */
export function generateDkimKey(bits = 2048): DkimKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: bits });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyB64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
  };
}

/** The public half of a stored private key (for re-publishing the record). */
export function dkimPublicKeyOf(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({ type: 'spki', format: 'der' }).toString('base64');
}

/** `v=DKIM1; k=rsa; p=…` — the TXT value at `<selector>._domainkey.<domain>`. */
export function dkimRecordValue(publicKeyB64: string): string {
  return `v=DKIM1; k=rsa; p=${publicKeyB64}`;
}

/** Record name (zone-relative) for a selector. */
export function dkimRecordName(selector: string = DKIM_DEFAULT_SELECTOR): string {
  return `${selector}._domainkey`;
}

// ── message plumbing ─────────────────────────────────────────────────────────

interface HeaderField {
  /** Name as written. */
  name: string;
  /** The whole field as written, `Name: value` incl. folding, no trailing CRLF. */
  raw: string;
}

/** Normalise line endings to CRLF (messages built on Unix often carry bare LF). */
export function toCrlf(message: string): string {
  return message.replace(/\r?\n/g, '\r\n');
}

/** Split a message into header fields (unfolded boundaries kept) and body. */
export function splitMessage(message: string): { headers: HeaderField[]; body: string } {
  const m = toCrlf(message);
  const sep = m.indexOf('\r\n\r\n');
  const head = sep < 0 ? m : m.slice(0, sep);
  const body = sep < 0 ? '' : m.slice(sep + 4);
  const headers: HeaderField[] = [];
  for (const line of head.split('\r\n')) {
    if (/^[ \t]/.test(line) && headers.length) {
      headers[headers.length - 1]!.raw += `\r\n${line}`;
    } else if (line.length) {
      const colon = line.indexOf(':');
      headers.push({ name: colon < 0 ? line : line.slice(0, colon), raw: line });
    }
  }
  return { headers, body };
}

export type Canon = 'relaxed' | 'simple';

/** §3.4.4 relaxed body / §3.4.3 simple body. */
export function canonicalizeBody(body: string, canon: Canon): string {
  let b = toCrlf(body);
  if (canon === 'relaxed') {
    b = b
      .split('\r\n')
      .map((line) => line.replace(/[ \t]+/g, ' ').replace(/ +$/, ''))
      .join('\r\n');
    b = b.replace(/(\r\n)*$/, '');
    return b.length ? `${b}\r\n` : '';
  }
  b = b.replace(/(\r\n)*$/, '');
  return `${b}\r\n`;
}

/** §3.4.2 relaxed header / §3.4.1 simple header — one field, no trailing CRLF. */
export function canonicalizeHeader(raw: string, canon: Canon): string {
  if (canon === 'simple') return raw;
  const colon = raw.indexOf(':');
  const name = raw.slice(0, colon).trim().toLowerCase();
  const value = raw
    .slice(colon + 1)
    .replace(/\r\n(?=[ \t])/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
  return `${name}:${value}`;
}

function bodyHash(body: string, canon: Canon, length?: number): string {
  let c = canonicalizeBody(body, canon);
  if (length !== undefined) c = c.slice(0, length);
  return createHash('sha256').update(c, 'utf8').digest('base64');
}

/** Pick header instances for `h=` bottom-up (§5.4.2); missing → omitted. */
function selectHeaders(headers: HeaderField[], names: string[]): HeaderField[] {
  const used = new Set<number>();
  const out: HeaderField[] = [];
  for (const n of names) {
    const want = n.trim().toLowerCase();
    for (let i = headers.length - 1; i >= 0; i--) {
      if (used.has(i)) continue;
      if (headers[i]!.name.trim().toLowerCase() === want) {
        used.add(i);
        out.push(headers[i]!);
        break;
      }
    }
  }
  return out;
}

/** Parse a tag=value list (`v=1; a=rsa-sha256; …`) — whitespace in values dropped for b/bh/p. */
export function parseTags(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of value.replace(/\r\n(?=[ \t])/g, '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    out[k] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Replace the b= tag's value with nothing, leaving the rest byte-identical (§3.5). */
function blankSignature(raw: string): string {
  return raw.replace(/((?:^|;)[ \t\r\n]*b[ \t\r\n]*=)[^;]*/i, '$1');
}

// ── sign ─────────────────────────────────────────────────────────────────────

/** Headers signed by default (the RFC's SHOULD list, minus trace fields). */
export const DEFAULT_SIGNED_HEADERS = [
  'from',
  'to',
  'cc',
  'subject',
  'date',
  'message-id',
  'reply-to',
  'mime-version',
  'content-type',
  'content-transfer-encoding',
  'in-reply-to',
  'references',
] as const;

export interface DkimSignOptions {
  domain: string;
  selector?: string;
  privateKeyPem: string;
  /** Header names to sign (only those present are listed; `from` always). */
  headers?: readonly string[];
  /** Signature timestamp (seconds). Default now. */
  timestamp?: number;
}

/** Sign a message; returns the message with a `DKIM-Signature` header prepended. */
export function dkimSign(message: string, opts: DkimSignOptions): string {
  const msg = toCrlf(message);
  const { headers, body } = splitMessage(msg);
  const present = new Set(headers.map((h) => h.name.trim().toLowerCase()));
  const names = [...new Set(['from', ...(opts.headers ?? DEFAULT_SIGNED_HEADERS)].map((n) => n.toLowerCase()))].filter(
    (n) => present.has(n),
  );
  const t = opts.timestamp ?? Math.floor(Date.now() / 1000);
  const bh = bodyHash(body, 'relaxed');
  const unsigned =
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=${opts.domain}; ` +
    `s=${opts.selector ?? DKIM_DEFAULT_SELECTOR}; t=${t}; h=${names.join(':')}; bh=${bh}; b=`;
  const data = signingInput(selectHeaders(headers, names), unsigned, 'relaxed');
  const b = sign('sha256', Buffer.from(data, 'utf8'), createPrivateKey(opts.privateKeyPem)).toString('base64');
  return `${unsigned}${foldB64(b)}\r\n${msg}`;
}

function foldB64(b: string): string {
  // Fold the signature so no line exceeds ~78 chars (relaxed canon ignores it).
  const parts = b.match(/.{1,72}/g) ?? [b];
  return parts.join('\r\n ');
}

function signingInput(fields: HeaderField[], sigRaw: string, canon: Canon): string {
  const lines = fields.map((f) => `${canonicalizeHeader(f.raw, canon)}\r\n`);
  return lines.join('') + canonicalizeHeader(blankSignature(sigRaw), canon);
}

// ── verify ───────────────────────────────────────────────────────────────────

export interface DkimVerifyResult {
  status: 'pass' | 'fail' | 'none' | 'temperror' | 'permerror';
  domain?: string;
  selector?: string;
  /** Plain-words reason when not a pass. */
  reason?: string;
}

/** Looks up the TXT strings at a name (joined per record). */
export type TxtLookup = (name: string) => Promise<string[]>;

/**
 * Verify the FIRST DKIM-Signature (optionally the first for `domain`) against
 * the public key from `keyFor` — a fixed base64 key or a TXT lookup.
 */
export async function dkimVerify(
  message: string,
  keyFor: { publicKeyB64: string } | { lookup: TxtLookup },
  opts: { domain?: string; now?: number } = {},
): Promise<DkimVerifyResult> {
  const { headers, body } = splitMessage(message);
  const sigs = headers.filter((h) => h.name.trim().toLowerCase() === 'dkim-signature');
  const pick = sigs
    .map((h) => ({ h, tags: parseTags(h.raw.slice(h.raw.indexOf(':') + 1)) }))
    .find((s) => !opts.domain || s.tags.d?.toLowerCase() === opts.domain.toLowerCase());
  if (!pick) return { status: 'none', reason: 'no DKIM-Signature header' };
  const { h: sigField, tags } = pick;
  const domain = tags.d;
  const selector = tags.s;
  const base = { domain, selector };
  if (tags.v !== '1' || !domain || !selector || !tags.h || !tags.bh || tags.b === undefined) {
    return { status: 'permerror', ...base, reason: 'malformed signature tags' };
  }
  if ((tags.a ?? '').toLowerCase() !== 'rsa-sha256') {
    return { status: 'permerror', ...base, reason: `unsupported algorithm ${tags.a}` };
  }
  const [hc, bc] = (tags.c ?? 'simple/simple').toLowerCase().split('/') as [Canon, Canon | undefined];
  const headerCanon: Canon = hc === 'relaxed' ? 'relaxed' : 'simple';
  const bodyCanon: Canon = (bc ?? 'simple') === 'relaxed' ? 'relaxed' : 'simple';
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (tags.x && Number(tags.x) < now) return { status: 'fail', ...base, reason: 'signature expired' };

  const length = tags.l !== undefined ? Number(tags.l) : undefined;
  const bh = bodyHash(body, bodyCanon, length);
  if (bh !== tags.bh.replace(/\s+/g, '')) return { status: 'fail', ...base, reason: 'body hash mismatch' };

  let publicKeyB64: string;
  if ('publicKeyB64' in keyFor) {
    publicKeyB64 = keyFor.publicKeyB64;
  } else {
    let records: string[];
    try {
      records = await keyFor.lookup(`${selector}._domainkey.${domain}`);
    } catch (e) {
      return { status: 'temperror', ...base, reason: `key lookup failed: ${e instanceof Error ? e.message : e}` };
    }
    const rec = records.map(parseTags).find((r) => r.p !== undefined && (r.v ?? 'DKIM1') === 'DKIM1');
    if (!rec) return { status: 'permerror', ...base, reason: 'no DKIM key record' };
    if (!rec.p) return { status: 'fail', ...base, reason: 'key revoked' };
    publicKeyB64 = rec.p.replace(/\s+/g, '');
  }

  const names = tags.h.split(':');
  const data = signingInput(selectHeaders(headers, names), sigField.raw, headerCanon);
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyB64, 'base64'), format: 'der', type: 'spki' });
    ok = verify('sha256', Buffer.from(data, 'utf8'), key, Buffer.from(tags.b.replace(/\s+/g, ''), 'base64'));
  } catch (e) {
    return { status: 'permerror', ...base, reason: `bad public key: ${e instanceof Error ? e.message : e}` };
  }
  return ok ? { status: 'pass', ...base } : { status: 'fail', ...base, reason: 'signature does not verify' };
}
