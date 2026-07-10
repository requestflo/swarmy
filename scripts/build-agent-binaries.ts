// SPDX-License-Identifier: FSL-1.1-ALv2
// Compile the agent to standalone host binaries + a sha256 manifest.
//
// This is what makes the systemd install backend real: the installer downloads
// `<controller>/install/bin/<platform>` and verifies it against the pinned
// sha256 — both served from the directory this script fills.
//
// Run: bun run scripts/build-agent-binaries.ts [outDir]
//   outDir defaults to apps/agent/dist-bin. Targets via AGENT_BIN_TARGETS
//   (comma-separated bun targets), default linux-x64,linux-arm64. Add
//   `host` for a local-platform binary (dev/e2e on macOS).
//
// Output:
//   <outDir>/swarmy-agent-<platform>          one binary per target
//   <outDir>/manifest.json                    { version, platforms: { <platform>: { sha256, size } } }
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const OUT_DIR = path.resolve(ROOT, process.argv[2] ?? 'apps/agent/dist-bin');
// main.ts = CLI dispatcher (status/doctor/backup/…); no-args under systemd
// still daemonizes, and `--version` keeps its exact probe-able output.
const ENTRY = path.join(ROOT, 'apps/agent/src/main.ts');

const hostPlatform = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`;
const targets = (process.env.AGENT_BIN_TARGETS ?? 'linux-x64,linux-arm64')
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => (t === 'host' ? hostPlatform : t));

// The binary reports the release-stamped package.json version (see
// apps/agent/src/version.ts) — the manifest must carry the same value or the
// dashboard's "update available" comparison lies.
const pkg = (await Bun.file(path.join(ROOT, 'apps/agent/package.json')).json()) as { version: string };
const commit = process.env.SWARMY_COMMIT ?? '';

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

/**
 * The TUI's @opentui/core resolves a per-platform native package via
 * statically-analyzable `import("@opentui/core-<platform>")` calls, which
 * `bun build --compile` embeds into the binary — but ONLY if the package
 * exists in node_modules. `bun install` skips foreign-platform packages
 * (os/cpu filters), so cross-compiling from macOS to linux would silently
 * miss them. Fetch any missing target's package straight from the npm
 * registry into root node_modules (module resolution's last ascent level).
 */
async function ensureOpentuiNativePackage(platform: string): Promise<void> {
  const pkgName = `@opentui/core-${platform}`;
  const destDir = path.join(ROOT, 'node_modules', '@opentui', `core-${platform}`);
  if (await Bun.file(path.join(destDir, 'package.json')).exists()) return;

  const corePkg = (await Bun.file(
    path.join(ROOT, 'apps/agent/node_modules/@opentui/core/package.json'),
  ).json()) as { version: string };
  const url = `https://registry.npmjs.org/${pkgName}/-/core-${platform}-${corePkg.version}.tgz`;
  console.log(`==> fetching ${pkgName}@${corePkg.version} (native TUI lib for cross-compile)`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${url}: HTTP ${res.status}`);
  await mkdir(destDir, { recursive: true });
  const tar = Bun.spawn(['tar', '-xzf', '-', '-C', destDir, '--strip-components=1'], {
    stdin: new Uint8Array(await res.arrayBuffer()),
    stdout: 'ignore',
    stderr: 'inherit',
  });
  if ((await tar.exited) !== 0) throw new Error(`failed to extract ${pkgName}`);
}

for (const platform of targets) {
  if (platform.startsWith('linux-') || platform.startsWith('darwin-')) {
    await ensureOpentuiNativePackage(platform);
  }
}

const platforms: Record<string, { sha256: string; size: number }> = {};

for (const platform of targets) {
  const outfile = path.join(OUT_DIR, `swarmy-agent-${platform}`);
  console.log(`==> compiling ${platform}`);
  const args = [
    'bun',
    'build',
    '--compile',
    `--target=bun-${platform}`,
    ENTRY,
    '--outfile',
    outfile,
    ...(commit ? [`--define=process.env.SWARMY_COMMIT="${commit}"`] : []),
    // Pin the TUI's libc branch at build time so only the glibc native lib is
    // embedded (our targets are Ubuntu/Debian-class; musl would need a
    // separate -musl target set).
    ...(platform.startsWith('linux-') ? ['--define=process.env.OPENTUI_LIBC="glibc"'] : []),
    // Kill Bun's automatic `.env` loading from the CWD: a stray .env in
    // whatever directory the operator runs `swarmy-agent` from must never
    // poison the agent's configuration (/etc/swarmy/agent.env + real env are
    // the only config sources).
    '--compile-exec-argv=--env-file=/dev/null',
  ];
  const proc = Bun.spawn(args, { cwd: ROOT, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) {
    console.error(`compile failed for ${platform}`);
    process.exit(1);
  }
  const bytes = await Bun.file(outfile).arrayBuffer();
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(bytes);
  platforms[platform] = { sha256: hasher.digest('hex'), size: bytes.byteLength };
}

const manifest = { version: pkg.version, commit: commit || undefined, platforms };
await Bun.write(path.join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`==> wrote ${Object.keys(platforms).length} binaries + manifest.json to ${OUT_DIR}`);
for (const [platform, meta] of Object.entries(platforms)) {
  console.log(`    ${platform}  ${meta.sha256}  ${(meta.size / 1024 / 1024).toFixed(1)}MB`);
}
