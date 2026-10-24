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
 * Load (the simple way): Settings → Platform → Import release → The bundle
 * (.tar). The browser sends the file to the controller, which verifies the
 * signature offline, pushes every image into the built-in registry at the
 * system-image mirror's `swarmy-system/<host>/<path>:<tag>` paths, records
 * the `swarmy.mirror.*` labels and offers the release — no egress needed
 * (packages/trpc/src/services/platform-bundle.*).
 *
 * Or by hand, for a bundle too big to send through a browser: push.sh copies
 * each image into the built-in registry at those same paths, then Import
 * release → Only platform.json + .sig adopts the pushed copies as trusted
 * mirror entries and the normal Upgrade runs against them.
 *
 * The signature is checked here first (`SWARMY_RELEASE_PUBKEY` overrides the
 * built-in release key): a bundle the controller would refuse is never built.
 * CI: .github/workflows/bundle.yml (manual).
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { releasePublicKey, verifyPlatformManifest } from '../packages/core/src/platform-verify';
import { SYSTEM_MIRROR_NAMESPACE, parseImageRef } from '../packages/core/src/system-images';

const [manifestPath, sigPath, outTar] = process.argv.slice(2);
if (!manifestPath || !sigPath || !outTar) {
  console.error('usage: bun scripts/platform-bundle.ts platform.json platform.json.sig out.tar');
  process.exit(2);
}
const verified = verifyPlatformManifest(readFileSync(manifestPath, 'utf8'), readFileSync(sigPath, 'utf8'), releasePublicKey());
if (!verified.ok) {
  console.error(`refusing to bundle an unverified release: ${verified.reason}`);
  process.exit(1);
}
const m = verified.manifest;
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
push.push(`echo "done: ${n} image(s) in $REG. Now import platform.json + platform.json.sig in Settings → Platform → Import release → Only platform.json + .sig."`);
writeFileSync(join(dir, 'push.sh'), `${push.join('\n')}\n`, { mode: 0o755 });
const t = Bun.spawnSync(['tar', '-cf', resolve(outTar), '-C', work, 'swarmy-bundle'], { stdout: 'inherit', stderr: 'inherit' });
if (t.exitCode !== 0) throw new Error('tar failed');
rmSync(work, { recursive: true, force: true });
console.log(`${outTar}: swarmy ${m.version}, ${n} image(s)`);
