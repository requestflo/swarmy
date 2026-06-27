// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Stamp a single repo-wide version into every workspace package.json.
 *
 * Invoked by semantic-release's @semantic-release/exec `prepareCmd` with the
 * computed next version, BEFORE @semantic-release/git commits the result:
 *
 *   bun run scripts/set-version.ts ${nextRelease.version}
 *
 * swarmy ships as one deployable product (controller + agent images + install
 * script all move together), so a single version is the protocol version too.
 * apps/{api,agent}/src/version.ts read their own package.json at runtime, so
 * writing the version here is all that's needed for `GET /version` and
 * `swarmy-agent --version` to report it — no generated constant to keep in sync.
 *
 * Usage: bun run scripts/set-version.ts <version>
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`set-version: expected a semver version argument, got: ${version ?? '<none>'}`);
  process.exit(1);
}

function workspaceManifests(): string[] {
  const out: string[] = [join(repoRoot, 'package.json')];
  for (const group of ['apps', 'packages']) {
    const base = join(repoRoot, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const manifest = join(base, name, 'package.json');
      if (existsSync(manifest)) out.push(manifest);
    }
  }
  return out;
}

let changed = 0;
for (const manifest of workspaceManifests()) {
  const raw = readFileSync(manifest, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  if (pkg.version === version) continue;
  pkg.version = version;
  // Preserve trailing newline convention.
  const trailing = raw.endsWith('\n') ? '\n' : '';
  writeFileSync(manifest, `${JSON.stringify(pkg, null, 2)}${trailing}`);
  changed += 1;
  console.log(`set-version: ${manifest.replace(`${repoRoot}/`, '')} -> ${version}`);
}

console.log(`set-version: stamped ${version} into ${changed} manifest(s).`);
