#!/usr/bin/env bun
/**
 * Offline platform bundle (plans/epic-platform-upgrades.md §1, "Offline bundles").
 *
 * Build (anywhere with egress + docker):
 *   bun scripts/platform-bundle.ts platform.json platform.json.sig swarmy-<ver>.tar [--without data-images]
 *
 * `--without data-images` leaves out the BOM's data section (managed Postgres
 * at every offered major, caches, search, vector, and their backup helpers:
 * about 2 GB of the bundle). The bundle lists what it left out in
 * `omitted.txt`; the installer and the controller skip those, and the cluster
 * it installs can't create managed data offline.
 *
 * → a tar with `platform.json`, `platform.json.sig`, every image a node of the
 * release can pull as an OCI layout (`oci/`, one tag per BOM key,
 * digest-preserving `regctl image copy`), and `push.sh`. The image list is
 * the BOM at the release's digests (`planBundle`,
 * packages/core/src/platform-bundle-plan.ts), so nothing is missed: the
 * registry forwarder's Caddy, the NetBird client/relay/server, every system
 * image. A component the release names without a digest stops the build.
 *
 * Fresh air-gapped install: `install-swarmy.sh --bundle swarmy-<ver>.tar`
 * verifies the signature, docker-loads every image, and the controller then
 * seeds the built-in registry from it (system-images-bundle.service.ts).
 *
 * Load into a running cluster: Settings → Platform → Import release → The
 * bundle (.tar). The controller verifies the signature offline, pushes every
 * image into the built-in registry at the system-image mirror's
 * `swarmy-system/<host>/<path>:<tag>` paths, records the `swarmy.mirror.*`
 * labels and offers the release (packages/trpc/src/services/platform-bundle.*).
 *
 * Or by hand, for a bundle too big to send through a browser (on a swarm
 * MANAGER, docker only): `tar xf swarmy-<ver>.tar && sh swarmy-bundle/push.sh
 * [registry=localhost:5000]` (SWARMY_REG_USER / SWARMY_REG_PASS for the
 * built-in registry login), then Import release → Only platform.json + .sig
 * adopts the pushed copies as trusted mirror entries.
 *
 * The signature is checked here first (`SWARMY_RELEASE_PUBKEY` overrides the
 * built-in release key): a bundle the controller would refuse is never built.
 * CI: .github/workflows/bundle.yml (manual).
 */
import { mkdirSync, rmSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BUNDLE_OMITTED_FILE, BUNDLE_PARTS, planBundle, type BundlePart } from '../packages/core/src/platform-bundle-plan';
import { releasePublicKey, verifyPlatformManifest } from '../packages/core/src/platform-verify';
import { SYSTEM_MIRROR_NAMESPACE, parseImageRef } from '../packages/core/src/system-images';

const argv = process.argv.slice(2);
const without: BundlePart[] = [];
for (let i = argv.indexOf('--without'); i >= 0; i = argv.indexOf('--without')) {
  const part = argv.splice(i, 2)[1] as BundlePart | undefined;
  if (!part || !BUNDLE_PARTS.includes(part)) {
    console.error(`--without takes one of: ${BUNDLE_PARTS.join(', ')}`);
    process.exit(2);
  }
  without.push(part);
}
const [manifestPath, sigPath, outTar] = argv;
if (!manifestPath || !sigPath || !outTar) {
  console.error(`usage: bun scripts/platform-bundle.ts platform.json platform.json.sig out.tar [--without ${BUNDLE_PARTS.join('|')}]`);
  process.exit(2);
}
const verified = verifyPlatformManifest(readFileSync(manifestPath, 'utf8'), readFileSync(sigPath, 'utf8'), releasePublicKey());
if (!verified.ok) {
  console.error(`refusing to bundle an unverified release: ${verified.reason}`);
  process.exit(1);
}
const m = verified.manifest;
const plan = planBundle(m, undefined, { without });
if (plan.unresolved.length) {
  console.error(`refusing to bundle ${m.version}: it names ${plan.unresolved.join(', ')} without a digest, so a node would pull them.`);
  process.exit(1);
}
if (plan.notInRelease.length) console.log(`not in ${m.version} (its controller never runs them): ${plan.notInRelease.join(', ')}`);
if (plan.omitted.length) console.log(`left out (--without ${without.join(', ')}): ${plan.omitted.join(', ')} — this bundle can't create managed data offline`);
const REGCTL = 'ghcr.io/regclient/regctl:v0.9.0-alpine';
const work = resolve(`${outTar}.d`);
const dir = join(work, 'swarmy-bundle');
rmSync(work, { recursive: true, force: true });
mkdirSync(join(dir, 'oci'), { recursive: true });
copyFileSync(manifestPath, join(dir, 'platform.json'));
copyFileSync(sigPath, join(dir, 'platform.json.sig'));
if (plan.omitted.length) writeFileSync(join(dir, BUNDLE_OMITTED_FILE), `# left out with --without ${without.join(' ')}\n${plan.omitted.join('\n')}\n`);

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const push: string[] = [
  '#!/bin/sh',
  `# swarmy ${m.version} offline bundle: push every image into the built-in registry (mirror paths).`,
  'set -eu',
  'REG="${1:-localhost:5000}"',
  'HERE="$(cd "$(dirname "$0")" && pwd)"',
];
for (const img of plan.images) {
  console.log(`exporting ${img.key}: ${img.source}`);
  const r = Bun.spawnSync(['docker', 'run', '--rm', '--user', '0:0', '--entrypoint', 'regctl', '-v', `${join(dir, 'oci')}:/oci`, REGCTL, 'image', 'copy', img.source, `ocidir:///oci:${img.key}`], {
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (r.exitCode !== 0) throw new Error(`could not export ${img.source}`);
  const p = parseImageRef(img.ref);
  const dst = `$0/${SYSTEM_MIRROR_NAMESPACE}/${p.host}/${p.path}:${p.tag ?? 'latest'}`;
  push.push(
    `echo "pushing ${img.key}"`,
    `docker run --rm --network host --user 0:0 --entrypoint sh -v "$HERE/oci:/oci" ${REGCTL} -c ${sq(`regctl registry set "$0" --tls disabled >/dev/null 2>&1; [ -n "$1" ] && regctl registry login "$0" -u "$1" -p "$2" >/dev/null 2>&1; regctl image copy ocidir:///oci@${img.digest} "${dst}"`)} "$REG" "\${SWARMY_REG_USER:-}" "\${SWARMY_REG_PASS:-}"`,
  );
}
push.push(`echo "done: ${plan.images.length} image(s) in $REG. Now import platform.json + platform.json.sig in Settings → Platform → Import release → Only platform.json + .sig."`);
writeFileSync(join(dir, 'push.sh'), `${push.join('\n')}\n`, { mode: 0o755 });
const t = Bun.spawnSync(['tar', '-cf', resolve(outTar), '-C', work, 'swarmy-bundle'], { stdout: 'inherit', stderr: 'inherit' });
if (t.exitCode !== 0) throw new Error('tar failed');
rmSync(work, { recursive: true, force: true });
const mb = Math.round(Bun.file(resolve(outTar)).size / 1e6);
console.log(`${outTar}: swarmy ${m.version}, ${plan.images.length} image(s), ${mb} MB${plan.omitted.length ? ` (without ${without.join(', ')})` : ''}`);
