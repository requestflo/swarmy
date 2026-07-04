import type { DnsSnapshotBundle, DnsZoneSnapshot } from '@swarmy/core/protocol';

/**
 * Stable content signatures for push debounce and SOA serial management.
 *
 * The controller composes a candidate bundle every reconcile tick; it only
 * bumps zone serials and fans out `dns.apply` when the *answer-relevant*
 * content actually changed. Pure string hashing (FNV-1a 64) — no node:crypto,
 * so this runs identically in the controller, the worker, and tests.
 */

/** Canonical JSON: object keys sorted recursively so hashes are stable. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(',')}}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i) & 0xff);
    hash = (hash * FNV_PRIME) & MASK64;
    // Fold in the high byte of multi-byte chars so non-ASCII still contributes.
    const high = input.charCodeAt(i) >> 8;
    if (high) {
      hash ^= BigInt(high);
      hash = (hash * FNV_PRIME) & MASK64;
    }
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Signature of one zone's answer-relevant content. Excludes `serial` (the
 * serial is DERIVED from content changes — including it would make every bump
 * look like another change) and `generatedAt`-style timestamps.
 */
export function zoneSignature(zone: DnsZoneSnapshot): string {
  const { serial: _serial, ...content } = zone;
  return fnv1a64(canonical(content));
}

/** Signature of a whole bundle (zone order-insensitive). */
export function bundleSignature(bundle: DnsSnapshotBundle): string {
  const zoneSigs = bundle.zones
    .map((z) => `${z.zone}=${zoneSignature(z)}`)
    .sort()
    .join(';');
  return fnv1a64(zoneSigs);
}
