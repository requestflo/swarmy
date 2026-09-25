/**
 * The system-image bill of materials + in-swarm mirror (self-reliance B3/B4).
 *
 * Every image swarmy itself runs (its own controller/agent/edge/DNS builds and
 * the upstream tools: registry, BuildKit, Trivy, cosign, restic, Garage,
 * ClickHouse, the OTel collector, curl, …) is listed here once, with the
 * upstream INDEX digest pinned for third-party images. This is the
 * `components` half of the platform manifest (`plans/epic-platform-upgrades.md`
 * §1): CI's `platform.json` will fill in the digests of swarmy's own builds,
 * which float on `:latest` until then.
 *
 * The mirror: the controller copies each entry, byte-for-byte and multi-arch
 * (`regctl image copy` keeps the index digest), into the built-in `registry:2`
 * under `swarmy-system/<upstream path>`. The result is recorded on the registry
 * SERVICE as labels (Docker is the source of truth — no DB table):
 *
 *   swarmy.mirror.<key>  = <upstream ref>@<sha256 digest>
 *   swarmy.mirror.node   = <swarm node id the registry task ran on when copied>
 *
 * The node label matters: the registry's volume is node-local, so if its task
 * moves the copies are gone. A mirror entry is only trusted while the registry
 * runs on the recorded node; otherwise swarmy falls back to upstream and the
 * next mirror tick re-copies.
 *
 * Deploy by digest: the hub dispatch decorator rewrites a pull of an exact
 * upstream ref to `<registry>/swarmy-system/<path>@sha256:…` when it is
 * mirrored (and trusted), so every node pulls swarmy's images from the cluster.
 *
 * Pure module — no I/O. Unit-tested in `system-images.test.ts`.
 */

export type SystemImageKey =
  | 'registry'
  | 'regctl'
  | 'buildkit'
  | 'railpackFrontend'
  | 'railpackBuilder'
  | 'railpackRuntime'
  | 'railpackPrepare'
  | 'trivy'
  | 'cosign'
  | 'busybox'
  | 'restic'
  | 'walg'
  | 'garage'
  | 'garageV1'
  | 'clickhouse'
  | 'otelCollector'
  | 'curl'
  | 'valkey'
  | 'maddy'
  | 'dockerCli'
  | 'netbirdServer'
  | 'netbirdClient'
  | 'litestream'
  | 'caddy'
  | 'caddySwarmy'
  | 'dns'
  | 'agent'
  | 'controller'
  | 'appAuth';

export interface SystemImage {
  key: SystemImageKey;
  /** The ref EXACTLY as swarmy's code dispatches it (short Docker Hub names kept). */
  ref: string;
  /** Pinned upstream index digest (`sha256:…`). Absent = floating (swarmy's own builds until CI's platform.json). */
  digest?: string;
  /**
   * Excluded from the dispatch rewrite: the registry must never depend on
   * itself, and the copier must be pullable when the registry is empty.
   */
  noRewrite?: boolean;
}

/** Digests resolved 2026-09-24 against the upstream registries (multi-arch index digests). */
export const SYSTEM_IMAGES: readonly SystemImage[] = [
  { key: 'registry', ref: 'registry:2', digest: 'sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373', noRewrite: true },
  { key: 'regctl', ref: 'ghcr.io/regclient/regctl:v0.9.0-alpine', digest: 'sha256:9e5b4ad04dd7ee9b37b360289231eb4ebadfe3a72f3ddaa1cd6a585efb6d1e4c', noRewrite: true },
  { key: 'buildkit', ref: 'moby/buildkit:rootless', digest: 'sha256:80b15f0735e87bab7bf59ec4d695dfb4a7cfb25521cf56dc75d6f256285b63ef' },
  // Railpack v0.40.0 (zero-config builds). The frontend image also carries the
  // `railpack` CLI the builder runs for `prepare`, so plan and frontend are
  // always the same version. builder/runtime are the base images a v0.40.0
  // plan names (by tag, `mise-<version>`); the build rewrites them to these
  // digests (or their mirrored copies). Bump all three together.
  { key: 'railpackFrontend', ref: 'ghcr.io/railwayapp/railpack-frontend:v0.40.0', digest: 'sha256:fc6d5fa434c9310500dc18bebb0a4eb4854fee8546a6d7a090e7a36e39d9d153' },
  { key: 'railpackBuilder', ref: 'ghcr.io/railwayapp/railpack-builder:mise-2026.9.12', digest: 'sha256:a104c45734b7c59fa7f52ab5afac87c3a4dfa5ee1c5495ae0c798756c670c865' },
  { key: 'railpackRuntime', ref: 'ghcr.io/railwayapp/railpack-runtime:mise-2026.9.12', digest: 'sha256:b699280f7b492ddba483ee1d03badaae238b8846ff2ef1e71ad8a2fd637c25b5' },
  // Where `railpack prepare` runs (inside BuildKit): alpine + bash, which
  // mise's version resolvers need (the BuildKit image is busybox-only). A few
  // MB instead of pulling the whole railpack-builder image per build.
  { key: 'railpackPrepare', ref: 'bash:5.2', digest: 'sha256:a54fb4422b18f05dd3107c36f39d67b26334fda7ec89f4126052b45e228e2f15' },
  { key: 'trivy', ref: 'aquasec/trivy:0.58.1', digest: 'sha256:ab70a02200597efa04748f210f793936eb647cbcdb0ea69cc30b226d6f5a22c7' },
  { key: 'cosign', ref: 'gcr.io/projectsigstore/cosign:v2.4.1', digest: 'sha256:b03690aa52bfe94054187142fba24dc54137650682810633901767d8a3e15b31' },
  { key: 'busybox', ref: 'busybox:1.36', digest: 'sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662' },
  { key: 'restic', ref: 'restic/restic:0.16.4', digest: 'sha256:dad38b8042cfb1a759a958ed0061b888ebd05b1e780125a1fb4e2d687c6c0556' },
  { key: 'garage', ref: 'dxflrs/garage:v2.4.1', digest: 'sha256:9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020' },
  { key: 'garageV1', ref: 'dxflrs/garage:v1.0.1', digest: 'sha256:a5706cf1f3d7b349ac5133ec59ad8181b709270b75e5f2fa7b3e1a5c07d67137' },
  { key: 'clickhouse', ref: 'clickhouse/clickhouse-server:24.8-alpine', digest: 'sha256:b002e56ed5c16e224c312527f6fcba7e77216fec5d7a88a7828f59efc614feb5' },
  { key: 'otelCollector', ref: 'otel/opentelemetry-collector-contrib:0.111.0', digest: 'sha256:a2a52e43c1a80aa94120ad78c2db68780eb90e6d11c8db5b3ce2f6a0cc6b5029' },
  { key: 'curl', ref: 'curlimages/curl:8.10.1', digest: 'sha256:d9b4541e214bcd85196d6e92e2753ac6d0ea699f0af5741f8c6cccbfcf00ef4b' },
  { key: 'valkey', ref: 'valkey/valkey:8', digest: 'sha256:640c5e62cea04b6d6f2084232651d0cc70362d31f4f805e7be94dbed6855e8f2' },
  // Email service MTA (epic developer-platform §8): one Go binary with submission,
  // DKIM, a retry queue and smarthost routing, ~20–30 MB RSS (fits 1 GB nodes).
  { key: 'maddy', ref: 'foxcpp/maddy:0.9.5', digest: 'sha256:de42151adff6388edb5e4ee88f60334fa1ab85e309485193ecb1c2db20203315' },
  // Platform upgrades: `docker service update --image … --update-failure-action rollback`
  // one-shots (docker.sock bound) for the controller and system services.
  { key: 'dockerCli', ref: 'docker:27.5-cli', digest: 'sha256:851f91d241214e7c6db86513b270d58776379aacc5eb9c4a87e5b47115e3065c' },
  // Self-hosted mesh (plans/epic-self-hosted-mesh-and-fleets.md). Same refs +
  // digests as packages/mesh/src/images.ts — bump both together; the control
  // plane upgrades BEFORE the clients (NetBird's compatibility direction).
  { key: 'netbirdServer', ref: 'ghcr.io/netbirdio/netbird-server:0.79.0', digest: 'sha256:d1da0c0179c9e6f2ab7b48be54d06341b11037855a9426b9f2536aa79f13360b' },
  { key: 'netbirdClient', ref: 'ghcr.io/netbirdio/netbird:0.79.0', digest: 'sha256:9d8480d87b7f7c10d67b820eecf332ecca5c2756792d4bdfa532182b4fc3005f' },
  // Litestream for the NetBird SQLite files (the controller bakes the same 0.5.17 into its image).
  { key: 'litestream', ref: 'litestream/litestream:0.5.17', digest: 'sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a' },
  { key: 'caddy', ref: 'caddy:2-alpine', digest: 'sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b' },
  { key: 'caddySwarmy', ref: 'ghcr.io/requestflo/caddy-swarmy:latest' },
  { key: 'dns', ref: 'ghcr.io/requestflo/swarmy-dns:latest' },
  { key: 'agent', ref: 'ghcr.io/requestflo/swarmy-agent:latest' },
  { key: 'controller', ref: 'ghcr.io/requestflo/swarmy-controller:latest' },
  // Per-app Better Auth service for `auth:` in swarmy.yaml (docker/app-auth, dev-platform §2B).
  { key: 'appAuth', ref: 'ghcr.io/requestflo/swarmy-app-auth:latest' },
  // wal-g for managed Postgres PITR (docker/walg). wal-g ships release binaries, not
  // images, so swarmy builds this from the checksum-verified v3.0.3 Postgres build;
  // CI's platform.json pins its digest like the other swarmy builds (bom: walg).
  { key: 'walg', ref: 'ghcr.io/requestflo/swarmy-walg:latest' },
];

/** Repo namespace inside the built-in registry that holds the mirrored copies. */
export const SYSTEM_MIRROR_NAMESPACE = 'swarmy-system';
export const MIRROR_LABEL_PREFIX = 'swarmy.mirror.';
export const MIRROR_NODE_LABEL = 'swarmy.mirror.node';
/** Swarm sets this label on every task container. */
export const SWARM_NODE_ID_LABEL = 'com.docker.swarm.node.id';

const DIGEST_RE = /^sha256:[a-f0-9]{64}$/;

export interface ParsedRef {
  /** Registry host (`docker.io` for Hub shorthands). */
  host: string;
  /** Repository path (`library/busybox` for official images). */
  path: string;
  tag: string | null;
  digest: string | null;
}

/** Normalise a Docker image ref the way dockerd does (Hub shorthands → docker.io/library/…). */
export function parseImageRef(ref: string): ParsedRef {
  let rest = ref.trim();
  let digest: string | null = null;
  const at = rest.indexOf('@');
  if (at >= 0) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
  }
  const slash = rest.lastIndexOf('/');
  const colon = rest.lastIndexOf(':');
  let tag: string | null = null;
  if (colon > slash) {
    tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
  }
  const first = rest.split('/')[0] ?? '';
  const hasHost = rest.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  let host = hasHost ? first : 'docker.io';
  let path = hasHost ? rest.slice(first.length + 1) : rest;
  if (host === 'index.docker.io' || host === 'registry-1.docker.io') host = 'docker.io';
  if (host === 'docker.io' && !path.includes('/')) path = `library/${path}`;
  return { host, path, tag, digest };
}

/** `<registry>/swarmy-system/<host>/<path>` — the mirror repo (no tag/digest). */
export function mirrorRepoFor(ref: string, registryHost: string): string {
  const p = parseImageRef(ref);
  return `${registryHost}/${SYSTEM_MIRROR_NAMESPACE}/${p.host}/${p.path}`;
}

/** The upstream ref the copier pulls: digest-pinned when the BOM pins one. */
export function copySourceFor(img: SystemImage): string {
  const p = parseImageRef(img.ref);
  const base = `${p.host}/${p.path}`;
  return img.digest ? `${base}@${img.digest}` : `${base}:${p.tag ?? 'latest'}`;
}

/** The tag the copy lands under in the mirror (the upstream tag). */
export function copyTargetFor(img: SystemImage, registryHost: string): string {
  const p = parseImageRef(img.ref);
  return `${mirrorRepoFor(img.ref, registryHost)}:${p.tag ?? 'latest'}`;
}

export function mirrorLabelKey(key: SystemImageKey): string {
  return `${MIRROR_LABEL_PREFIX}${key}`;
}

/** Label value recorded after a successful copy. */
export function mirrorLabelValue(img: SystemImage, digest: string): string {
  return `${img.ref}@${digest}`;
}

/** Parse a mirror label value → `{ ref, digest }` (null when malformed). */
export function parseMirrorLabel(value: string | undefined): { ref: string; digest: string } | null {
  if (!value) return null;
  const at = value.lastIndexOf('@');
  if (at <= 0) return null;
  const digest = value.slice(at + 1);
  return DIGEST_RE.test(digest) ? { ref: value.slice(0, at), digest } : null;
}

export function systemImageForRef(ref: string, images: readonly SystemImage[] = SYSTEM_IMAGES): SystemImage | undefined {
  return images.find((i) => i.ref === ref);
}

export function systemImage(key: SystemImageKey, images: readonly SystemImage[] = SYSTEM_IMAGES): SystemImage {
  const hit = images.find((i) => i.key === key);
  if (!hit) throw new Error(`unknown system image ${key}`);
  return hit;
}

/**
 * The digest a mirrored copy may be used at, or null. A label is trusted only
 * when it records THIS ref (a BOM bump makes older copies stale), its digest
 * equals the BOM pin (when pinned), and the registry still runs on the node
 * the copy was made on (`registryNodeId`).
 */
export function trustedMirrorDigest(
  img: SystemImage,
  labels: Record<string, string>,
  registryNodeId: string | null,
): string | null {
  const rec = parseMirrorLabel(labels[mirrorLabelKey(img.key)]);
  if (!rec || rec.ref !== img.ref) return null;
  if (img.digest && rec.digest !== img.digest) return null;
  const node = labels[MIRROR_NODE_LABEL];
  if (!node || !registryNodeId || node !== registryNodeId) return null;
  return rec.digest;
}

/**
 * Rewrite an exact upstream system ref to its mirrored, digest-pinned ref, or
 * return null (not a system image, excluded, or not mirrored/trusted).
 */
export function mirroredRefFor(
  ref: string,
  registryHost: string,
  labels: Record<string, string>,
  registryNodeId: string | null,
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): string | null {
  const img = systemImageForRef(ref, images);
  if (!img || img.noRewrite) return null;
  const digest = trustedMirrorDigest(img, labels, registryNodeId);
  return digest ? `${mirrorRepoFor(img.ref, registryHost)}@${digest}` : null;
}

/**
 * Which entries a mirror tick copies. Pinned entries already trusted are
 * skipped (bytes can't change). Floating entries (swarmy's own `:latest`) are
 * re-copied every tick so the mirror follows upstream; a failed copy keeps the
 * previous label, so an offline tick never loses the mirror.
 */
export function planMirror(
  labels: Record<string, string>,
  registryNodeId: string | null,
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): SystemImage[] {
  return images.filter((img) => !img.digest || trustedMirrorDigest(img, labels, registryNodeId) === null);
}

export const MIRROR_OK_MARKER = '@@SWARMY-MIRROR-OK@@';
export const MIRROR_FAIL_MARKER = '@@SWARMY-MIRROR-FAIL@@';

/** Single-quote for POSIX sh. */
function sq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The copier script (runs in the regctl alpine image, host network, so the
 * registry answers at `localhost:5000` exactly as for node dockerd). Registry
 * creds come in as env (`SWARMY_REG_USER`/`SWARMY_REG_PASS`), never inlined.
 * Each copy prints `MIRROR_OK <key> <digest>` or `MIRROR_FAIL <key>`; one
 * failure never stops the rest.
 */
export function renderMirrorScript(items: readonly SystemImage[], registryHost: string): string {
  const lines = [
    'set -u',
    `regctl registry set ${sq(registryHost)} --tls disabled >/dev/null 2>&1 || true`,
    `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | regctl registry login ${sq(registryHost)} -u "$SWARMY_REG_USER" --pass-stdin >/dev/null 2>&1 || true; fi`,
  ];
  for (const img of items) {
    const src = sq(copySourceFor(img));
    const dst = sq(copyTargetFor(img, registryHost));
    lines.push(
      `if regctl image copy ${src} ${dst} >/dev/null 2>&1 && D=$(regctl image digest ${dst} 2>/dev/null); then echo "${MIRROR_OK_MARKER} ${img.key} $D"; else echo "${MIRROR_FAIL_MARKER} ${img.key}"; fi`,
    );
  }
  return lines.join('\n');
}

/** Parse the copier output → per-key digests that landed (+ the keys that failed). */
export function parseMirrorOutput(output: string): { ok: Map<SystemImageKey, string>; failed: SystemImageKey[] } {
  const ok = new Map<SystemImageKey, string>();
  const failed: SystemImageKey[] = [];
  for (const line of output.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === MIRROR_OK_MARKER && t[1] && t[2] && DIGEST_RE.test(t[2])) ok.set(t[1] as SystemImageKey, t[2]);
    else if (t[0] === MIRROR_FAIL_MARKER && t[1]) failed.push(t[1] as SystemImageKey);
  }
  return { ok, failed };
}

/**
 * Labels to stamp on the registry service after a tick. A copy whose digest
 * does not match the BOM pin is rejected (never trusted). When the registry
 * node changed, previous labels are dropped (their copies are on the old
 * node's volume) — only this tick's successes are kept.
 */
export function mirrorLabelsAfter(
  labels: Record<string, string>,
  registryNodeId: string,
  result: Map<SystemImageKey, string>,
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): { add: Record<string, string>; removeKeys: string[] } {
  const add: Record<string, string> = {};
  const removeKeys: string[] = [];
  const sameNode = labels[MIRROR_NODE_LABEL] === registryNodeId;
  for (const img of images) {
    const got = result.get(img.key);
    const k = mirrorLabelKey(img.key);
    if (got && (!img.digest || img.digest === got)) add[k] = mirrorLabelValue(img, got);
    else if (!sameNode && labels[k] !== undefined) removeKeys.push(k);
  }
  add[MIRROR_NODE_LABEL] = registryNodeId;
  return { add, removeKeys };
}

/** Keep only the mirror labels from a label set (to carry across a registry redeploy). */
export function mirrorLabelsOf(labels: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(labels).filter(([k]) => k.startsWith(MIRROR_LABEL_PREFIX)));
}

// ── Railpack (zero-config builds) ────────────────────────────────────────────

/** BOM keys of the base images a Railpack plan names (rewritten in the plan). */
export const RAILPACK_PLAN_IMAGE_KEYS = ['railpackBuilder', 'railpackRuntime'] as const satisfies readonly SystemImageKey[];

/**
 * The digest-pinned ref to use for a system image: the mirrored copy when it
 * is trusted, else the pinned upstream (`host/path@sha256:…`).
 */
export function pinnedSystemRef(
  key: SystemImageKey,
  mirror?: { registryHost: string; labels: Record<string, string>; registryNodeId: string | null },
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): string {
  const img = systemImage(key, images);
  const mirrored = mirror ? mirroredRefFor(img.ref, mirror.registryHost, mirror.labels, mirror.registryNodeId, images) : null;
  return mirrored ?? copySourceFor(img);
}

/**
 * Plan image rewrites for a Railpack build: the exact tag refs a plan names →
 * digest-pinned refs (mirrored when trusted), so a build never floats on a tag
 * and pulls from the cluster when it can.
 */
export function railpackImageRewrites(
  mirror?: { registryHost: string; labels: Record<string, string>; registryNodeId: string | null },
  images: readonly SystemImage[] = SYSTEM_IMAGES,
): Record<string, string> {
  return Object.fromEntries(
    RAILPACK_PLAN_IMAGE_KEYS.map((k) => [systemImage(k, images).ref, pinnedSystemRef(k, mirror, images)]),
  );
}
