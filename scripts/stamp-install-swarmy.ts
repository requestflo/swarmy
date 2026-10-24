#!/usr/bin/env bun
/**
 * Stamp the self-host installer with one release's pins (security review M14):
 * the controller + agent at the release's tag@digest from `platform.json` (built
 * from the BOM in packages/core/src/system-images.ts) and this checkout's
 * deploy/swarmy.lite.stack.yml, embedded. CI's Images workflow publishes the
 * result next to platform.json (<feed>/<channel>/install-swarmy.sh).
 *
 *   bun scripts/stamp-install-swarmy.ts --manifest platform.json [--out dist/install-swarmy.sh]
 *
 * Fails (and so fails the release job) when either image has no digest.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampInstallSwarmy } from '../apps/api/src/install/self-host-pins';
import { installerReleasePins, parsePlatformManifest } from '../packages/core/src/platform-manifest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const manifestFile = arg('manifest');
if (!manifestFile) {
  console.error('stamp-install-swarmy: --manifest <platform.json> is required');
  process.exit(1);
}
const out = arg('out') ?? join(root, 'dist', 'install-swarmy.sh');

const pins = installerReleasePins(parsePlatformManifest(readFileSync(manifestFile, 'utf8')));
const script = readFileSync(join(root, 'scripts/install-swarmy.sh'), 'utf8');
const stack = readFileSync(join(root, 'deploy/swarmy.lite.stack.yml'), 'utf8');
const stamped = stampInstallSwarmy(script, pins, stack);

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, stamped);
chmodSync(out, 0o755);
console.log(`stamp-install-swarmy: ${out} pinned to ${pins.version}: ${pins.controllerImage}, ${pins.agentImage}`);
