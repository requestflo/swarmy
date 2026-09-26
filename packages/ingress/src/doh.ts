/**
 * DNS-over-HTTPS request building + RFC 8484 wire format — pure.
 *
 * The controller asks ~12 public DoH resolvers (catalogue: `DOH_RESOLVERS` in
 * `@swarmy/core`). Only Cloudflare and Google serve the JSON API reliably, so
 * the rest are asked in RFC 8484 wire format: `GET <url>?dns=<base64url DNS
 * query>` with `accept: application/dns-message`, answered by a binary DNS
 * message. The tiny encoder/decoder here covers exactly what the domain check
 * needs (one A or AAAA question; A / AAAA / CNAME answers) and is golden-tested
 * byte for byte.
 *
 * `SWARMY_DOH_RESOLVERS` (parsed by {@link parseDohResolvers}):
 *   - unset                → every catalogue preset (the default 12)
 *   - `off` / `none` / ``  → no public resolvers (air-gapped: the controller's
 *                            own resolver + swarmy-dns decide)
 *   - comma list of preset ids (`cloudflare,google,quad9`) and/or URLs:
 *       `https://doh.internal/dns-query`       → JSON API (`?name=&type=`)
 *       `wire:https://doh.internal/dns-query`  → RFC 8484 wire format
 *       `json:https://…`                       → JSON, explicitly
 *     Unknown ids and non-https URLs are ignored.
 *
 * The "1.1.1.1 and 8.8.8.8 must agree" clause of the go-live gate applies only
 * to the anchors that are configured: a custom list without `cloudflare` /
 * `google` is gated on the 3-in-4 rule alone.
 */
import { DOH_RESOLVERS, type DohFormat } from '@swarmy/core';
import type { ResolverAnswer } from './domain-verify';

/** One DoH endpoint the controller asks. */
export interface DohEndpoint {
  /** Catalogue id, or the custom URL's host. Stored on each check. */
  id: string;
  url: string;
  format: DohFormat;
}

const DOH_OFF = new Set(['', 'off', 'none']);

/** PURE — parse `SWARMY_DOH_RESOLVERS` (see the file header). */
export function parseDohResolvers(raw: string | undefined): DohEndpoint[] {
  if (raw === undefined) return DOH_RESOLVERS.map(({ id, url, format }) => ({ id, url, format }));
  const v = raw.trim();
  if (DOH_OFF.has(v.toLowerCase())) return [];
  const out: DohEndpoint[] = [];
  const seen = new Set<string>();
  const push = (ep: DohEndpoint) => {
    if (seen.has(ep.id)) return;
    seen.add(ep.id);
    out.push(ep);
  };
  for (const item of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const preset = DOH_RESOLVERS.find((r) => r.id === item.toLowerCase());
    if (preset) {
      push({ id: preset.id, url: preset.url, format: preset.format });
      continue;
    }
    const m = /^(wire|json):(.*)$/i.exec(item);
    const format: DohFormat = m ? (m[1]!.toLowerCase() as DohFormat) : 'json';
    let u: URL;
    try {
      u = new URL(m ? m[2]! : item);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:') continue;
    push({ id: u.host, url: u.toString(), format });
  }
  return out;
}

export type DnsQType = 'A' | 'AAAA';
const QTYPE: Record<DnsQType, number> = { A: 1, AAAA: 28 };

/** The URL + accept header for one lookup against one endpoint. */
export function dohRequest(ep: DohEndpoint, name: string, type: DnsQType): { url: string; accept: string } {
  const sep = ep.url.includes('?') ? '&' : '?';
  if (ep.format === 'wire') {
    return { url: `${ep.url}${sep}dns=${base64Url(encodeDnsQuery(name, type))}`, accept: 'application/dns-message' };
  }
  return { url: `${ep.url}${sep}name=${encodeURIComponent(name)}&type=${type}`, accept: 'application/dns-json' };
}

// ───────────────────────────────────────────── wire format ──

/**
 * A DNS query message for one question (RFC 1035 §4.1): ID 0 (RFC 8484 §4.1
 * — cache-friendly), RD set, QDCOUNT 1, class IN.
 */
export function encodeDnsQuery(rawName: string, type: DnsQType): Uint8Array {
  const name = rawName.trim().toLowerCase().replace(/\.$/, '');
  const labels = name ? name.split('.') : [];
  const enc = new TextEncoder();
  const parts: number[] = [0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
  for (const label of labels) {
    const bytes = enc.encode(label);
    if (bytes.length === 0 || bytes.length > 63) throw new Error(`invalid DNS label in ${rawName}`);
    parts.push(bytes.length, ...bytes);
  }
  parts.push(0);
  const qt = QTYPE[type];
  parts.push(qt >> 8, qt & 0xff, 0, 1);
  return Uint8Array.from(parts);
}

/** base64url without padding (RFC 4648 §5), as RFC 8484 `?dns=` wants. */
export function base64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** RFC 5952 text form of a 16-byte IPv6 address (lowercase, longest zero run → `::`). */
export function ipv6Text(b: Uint8Array): string {
  const groups: number[] = [];
  for (let i = 0; i < 16; i += 2) groups.push((b[i]! << 8) | b[i + 1]!);
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLen && j - i >= 2) {
      best = i;
      bestLen = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (best < 0) return hex.join(':');
  return `${hex.slice(0, best).join(':')}::${hex.slice(best + bestLen).join(':')}`;
}

class Reader {
  constructor(private readonly b: Uint8Array) {}
  u8(at: number): number {
    if (at >= this.b.length) throw new Error('truncated');
    return this.b[at]!;
  }
  u16(at: number): number {
    return (this.u8(at) << 8) | this.u8(at + 1);
  }
  slice(at: number, len: number): Uint8Array {
    if (at + len > this.b.length) throw new Error('truncated');
    return this.b.subarray(at, at + len);
  }
  /** Read a (possibly compressed) name at `at`; returns it and the offset after it in the original stream. */
  name(at: number): { name: string; next: number } {
    const labels: string[] = [];
    let pos = at;
    let next = -1;
    for (let hops = 0; hops < 64; hops++) {
      const len = this.u8(pos);
      if (len === 0) {
        return { name: labels.join('.'), next: next < 0 ? pos + 1 : next };
      }
      if ((len & 0xc0) === 0xc0) {
        if (next < 0) next = pos + 2;
        pos = ((len & 0x3f) << 8) | this.u8(pos + 1);
        continue;
      }
      labels.push(new TextDecoder().decode(this.slice(pos + 1, len)));
      pos += 1 + len;
    }
    throw new Error('name compression loop');
  }
}

/**
 * Parse an RFC 8484 response (a binary DNS message) into an answer set — the
 * wire twin of `parseDohJson`. Tolerant: garbage in → an `error` answer.
 */
export function decodeDnsResponse(bytes: Uint8Array, resolver: string): ResolverAnswer {
  const out: ResolverAnswer = { resolver, a: [], aaaa: [], cname: [] };
  try {
    const r = new Reader(bytes);
    const flags = r.u16(2);
    if ((flags & 0x8000) === 0) return { ...out, error: 'malformed DNS response' };
    const rcode = flags & 0x0f;
    if (rcode === 3) return { ...out, nxdomain: true };
    if (rcode !== 0) return { ...out, error: rcode === 2 ? 'SERVFAIL' : `DNS status ${rcode}` };
    const qd = r.u16(4);
    const an = r.u16(6);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = r.name(pos).next + 4;
    for (let i = 0; i < an; i++) {
      pos = r.name(pos).next;
      const type = r.u16(pos);
      const rdlen = r.u16(pos + 8);
      const rdata = pos + 10;
      r.slice(rdata, rdlen);
      if (type === 1 && rdlen === 4) out.a.push([...r.slice(rdata, 4)].join('.'));
      else if (type === 28 && rdlen === 16) out.aaaa.push(ipv6Text(r.slice(rdata, 16)));
      else if (type === 5) out.cname.push(r.name(rdata).name.toLowerCase());
      pos = rdata + rdlen;
    }
    return out;
  } catch {
    return { ...out, a: [], aaaa: [], cname: [], error: 'malformed DNS response' };
  }
}
