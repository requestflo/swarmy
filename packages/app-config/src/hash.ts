/**
 * Deterministic signatures for desired units. The controller stamps a unit's
 * signature on its Docker object (`swarmy.app.sig`); the planner compares
 * desired vs live signatures to decide "changed" without re-deriving specs.
 * Dependency-free (browser-safe): canonical JSON + 64-bit FNV-1a.
 */

/** JSON with object keys sorted recursively; `undefined` members dropped. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v))
    return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const entries = Object.entries(v as Record<string, unknown>)
    .filter(([, x]) => x !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonicalJson(x)}`).join(',')}}`;
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** 16-hex-char FNV-1a-64 of the canonical JSON of `v`. */
export function signature(v: unknown): string {
  let h = FNV_OFFSET;
  const bytes = new TextEncoder().encode(canonicalJson(v));
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * FNV_PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}
