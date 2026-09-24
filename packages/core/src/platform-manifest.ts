/**
 * The platform release manifest (`platform.json`) — the cluster's bill of
 * materials for one swarmy release (plans/epic-platform-upgrades.md §1).
 *
 * GENERATED, never hand-maintained: {@link buildPlatformManifest} walks the
 * pinned BOM in `system-images.ts` and fills in the digests CI resolved for
 * swarmy's own builds (controller, agent, edge Caddy, DNS), which float on
 * `:latest` in the BOM. The CI Images workflow runs it
 * (`scripts/platform-manifest.ts`), signs the canonical bytes with the swarmy
 * release key, and publishes `<channel>/platform.json` + `.sig` to the feed.
 *
 * Signing contract: the signed bytes are {@link canonicalManifestJson} (sorted
 * keys, no whitespace), so the controller can re-verify a manifest it stored
 * as JSON. Verification lives in `platform-verify.ts` (node:crypto, offline).
 *
 * Pure module — no I/O. Unit-tested in `platform-manifest.test.ts`.
 */
import { z } from 'zod';
import { SYSTEM_IMAGES, parseImageRef, type SystemImage, type SystemImageKey } from './system-images';

export const PLATFORM_MANIFEST_SCHEMA = 1;
export type PlatformChannel = 'stable' | 'edge';
export const PLATFORM_CHANNELS: readonly PlatformChannel[] = ['stable', 'edge'];

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export const PlatformComponent = z.object({
  /** The ref EXACTLY as swarmy dispatches it (the BOM key's `ref`). */
  ref: z.string().min(1),
  /** Repository the digest lives in (`ghcr.io/requestflo/swarmy-controller`, `docker.io/library/registry`). */
  image: z.string().min(1),
  /** The tag CI published this build under (informational; deploys go by digest). */
  tag: z.string().optional(),
  /** Multi-arch index digest. Absent = unresolved (never deployed by a run). */
  digest: z.string().regex(DIGEST).optional(),
});
export type PlatformComponent = z.infer<typeof PlatformComponent>;

export const PlatformMigration = z.object({
  /** Registered migration id (e.g. `garage-v1-to-v2`). */
  id: z.string().min(1),
  /** Plain-words note shown before the admin confirms. */
  note: z.string(),
  /** Pauses service (e.g. object storage for ~1–2 min). */
  pause: z.boolean().optional(),
});
export type PlatformMigration = z.infer<typeof PlatformMigration>;

export const PlatformNote = z.object({
  kind: z.enum(['new', 'better', 'fix', 'security', 'breaking']),
  text: z.string().min(1),
});
export type PlatformNote = z.infer<typeof PlatformNote>;

export const PlatformManifest = z.object({
  schema: z.literal(PLATFORM_MANIFEST_SCHEMA),
  version: z.string().regex(SEMVER, 'version must be semver'),
  channel: z.enum(['stable', 'edge']),
  commit: z.string().default(''),
  publishedAt: z.string(),
  /** Oldest running version that may upgrade straight to this release. */
  minUpgradeFrom: z.string().regex(SEMVER).default('0.0.0'),
  components: z.record(PlatformComponent),
  migrations: z.array(PlatformMigration).default([]),
  notes: z.array(PlatformNote).default([]),
});
export type PlatformManifest = z.infer<typeof PlatformManifest>;

/** Parse + validate an untrusted manifest (feed, bundle, DB). Throws with a plain reason. */
export function parsePlatformManifest(input: unknown): PlatformManifest {
  const raw = typeof input === 'string' ? (JSON.parse(input) as unknown) : input;
  const r = PlatformManifest.safeParse(raw);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new Error(`invalid platform manifest: ${i?.path.join('.') || '(root)'} ${i?.message ?? ''}`.trim());
  }
  return r.data;
}

/** Stable serialization (sorted keys, no whitespace) — the bytes the release key signs. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function canonicalManifestJson(m: PlatformManifest): string {
  return canonicalJson(m);
}

/**
 * Registered platform migrations every release carries. The run decides
 * whether one applies to THIS cluster (e.g. the Garage step only migrates a
 * store still on v1) — listing it here is what the preflight report shows.
 */
export const PLATFORM_MIGRATIONS: PlatformMigration[] = [
  {
    id: 'garage-v1-to-v2',
    note:
      'Object storage on Garage v1 moves to v2 in place: metadata is snapshotted, every member restarts ' +
      'together (about one to two minutes without object storage), and any failure restores the snapshot on v1.',
    pause: true,
  },
];

// ── generation (CI) ──────────────────────────────────────────────────────────

export interface BuildManifestInput {
  version: string;
  channel: PlatformChannel;
  commit: string;
  publishedAt?: string;
  minUpgradeFrom?: string;
  /** Digests CI resolved for floating (own-build) entries, by BOM key. */
  digests?: Partial<Record<SystemImageKey, string>>;
  /** The tag CI published own builds under (`1.2.0`, `sha-abc1234`). */
  tag?: string;
  /** Per-key repo override (a fork/self-builder pushing elsewhere, or the e2e's local registry). */
  images?: Partial<Record<SystemImageKey, string>>;
  migrations?: PlatformMigration[];
  notes?: PlatformNote[];
  bom?: readonly SystemImage[];
}

/**
 * Build `platform.json` from the BOM. Third-party entries keep their pinned
 * digest; own builds take CI's digest. Throws when a digest is malformed.
 */
export function buildPlatformManifest(input: BuildManifestInput): PlatformManifest {
  const bom = input.bom ?? SYSTEM_IMAGES;
  const components: Record<string, PlatformComponent> = {};
  for (const img of bom) {
    const p = parseImageRef(img.ref);
    const resolved = input.digests?.[img.key];
    if (resolved !== undefined && !DIGEST.test(resolved)) throw new Error(`bad digest for ${img.key}: ${resolved}`);
    if (resolved && img.digest && resolved !== img.digest) {
      throw new Error(`${img.key} is pinned to ${img.digest} in system-images.ts; CI resolved ${resolved}`);
    }
    const digest = img.digest ?? resolved;
    const own = !img.digest;
    components[img.key] = {
      ref: img.ref,
      image: input.images?.[img.key] ?? `${p.host}/${p.path}`,
      ...(own && input.tag ? { tag: input.tag } : p.tag ? { tag: p.tag } : {}),
      ...(digest ? { digest } : {}),
    };
  }
  return parsePlatformManifest({
    schema: PLATFORM_MANIFEST_SCHEMA,
    version: input.version,
    channel: input.channel,
    commit: input.commit,
    publishedAt: input.publishedAt ?? new Date().toISOString(),
    minUpgradeFrom: input.minUpgradeFrom ?? '0.0.0',
    components,
    migrations: input.migrations ?? [],
    notes: input.notes ?? [],
  });
}

/**
 * The manifest a controller implies when no release was ever applied: its own
 * compiled BOM (own builds unresolved) at its build version. The "from" side
 * of a first upgrade.
 */
export function builtInManifest(version: string, commit: string, bom: readonly SystemImage[] = SYSTEM_IMAGES): PlatformManifest {
  return buildPlatformManifest({
    version: SEMVER.test(version) ? version : '0.0.0',
    channel: /-edge\b/.test(version) ? 'edge' : 'stable',
    commit,
    publishedAt: new Date(0).toISOString(),
    bom,
  });
}

/**
 * The BOM with the manifest's digests filled in for floating entries — what
 * the system-image mirror copies and the dispatch rewrite deploys by. Refs are
 * kept EXACTLY as the code dispatches them (the rewrite matches on them); only
 * digests change. Pinned entries keep their pin unless the manifest names the
 * same ref (a newer controller's BOM is the manifest's own).
 */
export function manifestImages(m: PlatformManifest | null | undefined, bom: readonly SystemImage[] = SYSTEM_IMAGES): SystemImage[] {
  if (!m) return [...bom];
  return bom.map((img) => {
    const c = m.components[img.key];
    if (!c?.digest || c.ref !== img.ref) return img;
    return { ...img, digest: c.digest };
  });
}

/** `<image>@<digest>` for a component, or null when the manifest has no digest for it. */
export function componentRef(m: PlatformManifest, key: SystemImageKey): string | null {
  const c = m.components[key];
  return c?.digest ? `${c.image}@${c.digest}` : null;
}

// ── versions ─────────────────────────────────────────────────────────────────

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

export function parseSemver(v: string): Semver | null {
  const m = SEMVER.exec(v.trim().replace(/^v/, ''));
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] };
}

/** semver precedence: <0 when a < b. Unparseable versions sort lowest. */
export function compareVersions(a: string, b: string): number {
  const x = parseSemver(a);
  const y = parseSemver(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (const k of ['major', 'minor', 'patch'] as const) if (x[k] !== y[k]) return x[k] - y[k];
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // release > prerelease
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** A PATCH release (x.y.Z bump, not a prerelease) — the only kind auto-apply may take. */
export function isPatchUpgrade(from: string, to: string): boolean {
  const a = parseSemver(from);
  const b = parseSemver(to);
  if (!a || !b || b.pre.length) return false;
  return a.major === b.major && a.minor === b.minor && compareVersions(to, from) > 0;
}

/** Why `current` cannot take this manifest (null = it can). */
export function upgradeBlockReason(current: string, m: PlatformManifest): string | null {
  if (compareVersions(m.version, current) <= 0) return `already on ${current} (release is ${m.version})`;
  if (compareVersions(current, m.minUpgradeFrom) < 0) {
    return `${m.version} needs ${m.minUpgradeFrom} or newer first — upgrade to an intermediate release`;
  }
  return null;
}

// ── feed ─────────────────────────────────────────────────────────────────────

/** Default feed: rolling GitHub releases named after the channel (`stable`, `edge`). */
export const DEFAULT_PLATFORM_FEED_BASE = 'https://github.com/requestflo/swarmy/releases/download';

/**
 * Feed URLs for a channel. Precedence: the org setting → `SWARMY_PLATFORM_FEED_URL`
 * → the GitHub releases feed. Any HTTPS base serving `<channel>/platform.json`
 * and `<channel>/platform.json.sig` works (an air-gapped estate's static mirror).
 */
export function platformFeedUrl(
  channel: PlatformChannel,
  setting?: string | null,
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
): { manifest: string; signature: string; base: string } {
  const base = (setting?.trim() || env.SWARMY_PLATFORM_FEED_URL?.trim() || DEFAULT_PLATFORM_FEED_BASE).replace(/\/+$/, '');
  const manifest = `${base}/${channel}/platform.json`;
  return { base, manifest, signature: `${manifest}.sig` };
}

// ── maintenance window ───────────────────────────────────────────────────────

export const MaintenanceWindow = z.object({
  /** 0 = Sunday … 6 = Saturday (UTC). */
  days: z.array(z.number().int().min(0).max(6)).min(1),
  startHour: z.number().int().min(0).max(23),
  hours: z.number().int().min(1).max(12),
});
export type MaintenanceWindow = z.infer<typeof MaintenanceWindow>;

export const DEFAULT_MAINTENANCE_WINDOW: MaintenanceWindow = { days: [0], startHour: 2, hours: 2 };

/** Is `at` inside the window? A window may run past midnight into the next day. UTC. */
export function inMaintenanceWindow(w: MaintenanceWindow, at: Date = new Date()): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  for (const d of w.days) {
    // Hours since the window opened on day d (this week or the previous day's spill).
    const since = ((day - d + 7) % 7) * 24 + hour - w.startHour;
    if (since >= 0 && since < w.hours) return true;
  }
  return false;
}

const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Sun, Wed 02:00–04:00 UTC". */
export function describeWindow(w: MaintenanceWindow): string {
  const pad = (h: number) => `${String(h % 24).padStart(2, '0')}:00`;
  const days = [...w.days].sort((a, b) => a - b).map((d) => DAY[d]).join(', ');
  return `${days} ${pad(w.startHour)}–${pad(w.startHour + w.hours)} UTC`;
}
