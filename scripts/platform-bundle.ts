#!/usr/bin/env bun
/**
 * Offline platform bundle (plans/epic-platform-upgrades.md §1, "Offline bundles").
 *
 * Build (anywhere with egress + docker):
 *   bun scripts/platform-bundle.ts platform.json platform.json.sig swarmy-<ver>.tar
 *
 * → a tar with `platform.json`, `platform.json.sig`, every BOM image of the
 * release as an OCI layout (`oci/`, one tag per component, digest-preserving
 * `regctl image copy`), and `push.sh`.
 *
 * Import (on a swarm MANAGER of the air-gapped cluster, docker only):
 *   tar xf swarmy-<ver>.tar && sh swarmy-bundle/push.sh [registry=localhost:5000]
 *   (SWARMY_REG_USER / SWARMY_REG_PASS for the built-in registry login)
 *
 * push.sh copies each image into the built-in registry at the SAME
 * `swarmy-system/<host>/<path>:<tag>` paths the system-image mirror uses.
 * Then Settings → Platform → Import release (platform.json + .sig): the
 * controller verifies the signature offline, adopts the pushed copies as
 * trusted mirror entries (labels on the registry service) and the normal
 * Upgrade runs against them — no egress needed.
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parsePlatformManifest } from '../packages/core/src/platform-manifest';
import { SYSTEM_MIRROR_NAMESPACE, parseImageRef } from '../packages/core/src/system-images';

const [manifestPath, sigPath, outTar] = process.argv.slice(2);
if (!manifestPath || !sigPath || !outTar) {
  console.error('usage: bun scripts/platform-bundle.ts platform.json platform.json.sig out.tar');
  process.exit(2);
}
const m = parsePlatformManifest(readFileSync(manifestPath, 'utf8'));
const REGCTL = 'ghcr.io/regclient/regctl:v0.9.0-alpine';
const work = resolve(`${outTar}.d`);
const dir = join(work, 'swarmy-bundle');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(dir, 'oci'), { recursive: true });
copyFileSync(manifestPath, join(dir, 'platform.json'));
copyFileSync(sigPath, join(dir, 'platform.json.sig'));

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const push: string[] = [
  '#!/bin/sh',
  `# swarmy ${m.version} offline bundle: push every image into the built-in registry (mirror paths).`,
  'set -eu',
  'REG="${1:-localhost:5000}"',
  'HERE="$(cd "$(dirname "$0")" && pwd)"',
];
let n = 0;
for (const [key, c] of Object.entries(m.components)) {
  if (!c.digest) continue;
  const src = `${c.image}@${c.digest}`;
  console.log(`exporting ${key}: ${src}`);
  const r = Bun.spawnSync(['docker', 'run', '--rm', '--user', '0:0', '--entrypoint', 'regctl', '-v', `${join(dir, 'oci')}:/oci`, REGCTL, 'image', 'copy', src, `ocidir:///oci:${key}`], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) throw new Error(`could not export ${src}`);
  const p = parseImageRef(c.ref);
  const dst = `$REG/${SYSTEM_MIRROR_NAMESPACE}/${p.host}/${p.path}:${p.tag ?? 'latest'}`;
  push.push(
    `echo "pushing ${key}"`,
    `docker run --rm --network host --user 0:0 --entrypoint sh -v "$HERE/oci:/oci" ${REGCTL} -c ${sq(`regctl registry set "$0" --tls disabled >/dev/null 2>&1; [ -n "$1" ] && regctl registry login "$0" -u "$1" -p "$2" >/dev/null 2>&1; regctl image copy ocidir:///oci:${key} "${dst.replace('$REG', '$0')}"`)} "$REG" "\${SWARMY_REG_USER:-}" "\${SWARMY_REG_PASS:-}"`,
  );
  n++;
}
push.push(`echo "done: ${n} image(s) in $REG. Now import platform.json + platform.json.sig in Settings → Platform → Import release."`);
writeFileSync(join(dir, 'push.sh'), `${push.join('\n')}\n`, { mode: 0o755 });
const t = Bun.spawnSync(['tar', '-cf', resolve(outTar), '-C', work, 'swarmy-bundle'], { stdout: 'inherit', stderr: 'inherit' });
if (t.exitCode !== 0) throw new Error('tar failed');
rmSync(work, { recursive: true, force: true });
console.log(`${outTar}: swarmy ${m.version}, ${n} image(s)`);
