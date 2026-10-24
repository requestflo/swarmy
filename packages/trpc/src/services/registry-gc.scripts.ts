/**
 * Registry GC one-shots (PURE renderers + parsers; unit-tested).
 *
 *  - scan    — `registry:2` image on the node that holds the registry volume
 *              (bound READ-ONLY): lists manifests no tag and no index in the
 *              same repo points at, plus size/repo/image counts.
 *  - delete  — BOM `regctl` on a manager (host network → `localhost:5000`,
 *              creds via env): `DELETE /v2/<repo>/manifests/<digest>` per
 *              planned manifest (+ its cosign `.sig` tag) while the registry
 *              is still read-write.
 *  - collect — `registry:2` image, volume bound read-write, while the registry
 *              service runs read-only: `registry garbage-collect` (mark-and-sweep
 *              of blobs no manifest references), then the same counts.
 *
 * `--delete-untagged` is deliberately NOT passed: on registry 2.x it deletes
 * the per-platform manifests under a tagged multi-arch index (they are
 * untagged children — the system-image mirror is all indexes), and it would
 * delete an untagged digest that still runs in prod (a superseded `:main`).
 * The scan + delete above reclaim the same untagged manifests while honouring
 * the pinned set and index children.
 */
import type { RegistryDelete, UntaggedManifest } from './registry-gc.plan';

export const REG_UNTAGGED = '@@SWARMY-REG-UNTAGGED@@';
export const REG_STATS = '@@SWARMY-REG-STATS@@';
export const REG_GC = '@@SWARMY-REG-GC@@';
export const REG_BEFORE = '@@SWARMY-REG-BEFORE@@';
export const REG_DELETED = '@@SWARMY-REG-DELETED@@';

export interface RegistryStats {
  sizeBytes: number;
  repos: number;
  /** Tags, minus build-cache and cosign signature tags. */
  images: number;
}

const REPO_RE = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*$/;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const ROOT = '/var/lib/registry';
const statsFn = (root: string) => [
  `V=${root}/docker/registry/v2; R=$V/repositories; B=$V/blobs/sha256`,
  'stats() {',
  '  repos=0; images=0',
  '  for m in $(find "$R" -type d -name _manifests 2>/dev/null); do',
  '    repos=$((repos+1))',
  `    n=$(ls "$m/tags" 2>/dev/null | grep -v '^buildcache-' | grep -vc '\\.sig$')`,
  '    images=$((images+n))',
  '  done',
  `  echo "${REG_STATS} $(du -sk ${root} | cut -f1) $repos $images"`,
  '}',
];

/** `root` is the registry's storage root inside the one-shot (a temp dir in tests). */
export function renderRegistryScanScript(max = 400, root = ROOT): string {
  return [
    'set -u',
    ...statsFn(root),
    'untagged() {',
    '  for m in $(find "$R" -type d -name _manifests 2>/dev/null); do',
    '    repo=${m#$R/}; repo=${repo%/_manifests}',
    '    tagged=$(for f in "$m"/tags/*/current/link; do [ -f "$f" ] && cat "$f" && echo; done)',
    '    refs=""',
    '    for h in $(ls "$m/revisions/sha256" 2>/dev/null); do',
    '      b="$B/$(echo "$h" | cut -c1-2)/$h/data"',
    `      grep -q '"manifests"' "$b" 2>/dev/null || continue`,
    `      for d in $(grep -o 'sha256:[0-9a-f]\\{64\\}' "$b" | sort -u); do`,
    '        [ -d "$m/revisions/sha256/${d#sha256:}" ] && refs="$refs $d"',
    '      done',
    '    done',
    '    for h in $(ls "$m/revisions/sha256" 2>/dev/null); do',
    '      d="sha256:$h"',
    `      printf '%s\\n' "$tagged" | grep -qx "$d" && continue`,
    '      case " $refs " in *" $d "*) continue ;; esac',
    '      l="$m/revisions/sha256/$h/link"; t=$(stat -c %Y "$l" 2>/dev/null || stat -f %m "$l" 2>/dev/null || echo 0)',
    `      echo "${REG_UNTAGGED} $repo $d $t"`,
    '    done',
    '  done',
    '}',
    `untagged | head -n ${Math.max(1, Math.floor(max))}`,
    'stats',
  ].join('\n');
}

export function renderRegistryCollectScript(root = ROOT): string {
  return [
    'set -u',
    ...statsFn(root),
    `echo "${REG_BEFORE} $(du -sk ${root} | cut -f1)"`,
    // The sweep log names every blob; keep only its tail (runOnce output is capped).
    'registry garbage-collect /etc/docker/registry/config.yml >/tmp/gc.log 2>&1',
    `echo "${REG_GC} $?"`,
    'tail -n 5 /tmp/gc.log',
    'stats',
  ].join('\n');
}

export function renderRegistryDeleteScript(deletes: readonly RegistryDelete[], host: string): string {
  const lines = [
    'set -u',
    `regctl registry set ${sq(host)} --tls disabled >/dev/null 2>&1 || true`,
    `if [ -n "\${SWARMY_REG_USER:-}" ]; then printf '%s' "$SWARMY_REG_PASS" | regctl registry login ${sq(host)} -u "$SWARMY_REG_USER" --pass-stdin >/dev/null 2>&1 || true; fi`,
  ];
  for (const d of deletes) {
    if (!REPO_RE.test(d.repo) || !DIGEST_RE.test(d.digest)) continue;
    const ref = sq(`${host}/${d.repo}@${d.digest}`);
    const sig = sq(`${host}/${d.repo}:${d.digest.replace(':', '-')}.sig`);
    lines.push(
      `if regctl manifest head ${ref} >/dev/null 2>&1 && regctl manifest delete ${ref} >/dev/null 2>&1; then echo "${REG_DELETED} ${d.repo}@${d.digest}"; regctl tag delete ${sig} >/dev/null 2>&1 || true; fi`,
    );
  }
  return lines.join('\n');
}

function statsOf(t: string[]): RegistryStats | null {
  const [kb, repos, images] = t.slice(1, 4).map(Number);
  return [kb, repos, images].every((n) => Number.isFinite(n) && (n as number) >= 0)
    ? { sizeBytes: (kb as number) * 1024, repos: repos as number, images: images as number }
    : null;
}

export interface ParsedRegistryOutput {
  untagged: UntaggedManifest[];
  stats: RegistryStats | null;
  /** collect only: size before the sweep (bytes) and `garbage-collect`'s exit code. */
  beforeBytes: number | null;
  gcExit: number | null;
  deleted: string[];
}

/** Parse any of the three outputs. Lines are matched by their leading marker only. */
export function parseRegistryOutput(output: string): ParsedRegistryOutput {
  const out: ParsedRegistryOutput = { untagged: [], stats: null, beforeBytes: null, gcExit: null, deleted: [] };
  for (const line of output.split('\n')) {
    const t = line.trim().split(/\s+/);
    if (t[0] === REG_UNTAGGED && t.length === 4 && REPO_RE.test(t[1] ?? '') && DIGEST_RE.test(t[2] ?? '')) {
      const sec = Number(t[3]);
      if (Number.isFinite(sec) && sec > 0) out.untagged.push({ repo: t[1] as string, digest: t[2] as string, modifiedAt: new Date(sec * 1000) });
    } else if (t[0] === REG_STATS) out.stats = statsOf(t);
    else if (t[0] === REG_BEFORE && Number.isFinite(Number(t[1]))) out.beforeBytes = Number(t[1]) * 1024;
    else if (t[0] === REG_GC && Number.isFinite(Number(t[1]))) out.gcExit = Number(t[1]);
    else if (t[0] === REG_DELETED && t[1]) out.deleted.push(t[1]);
  }
  return out;
}
