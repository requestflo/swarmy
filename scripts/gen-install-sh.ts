// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Generate a version-pinned `install.sh` release asset.
 *
 * Reuses the controller's `renderInstallScript()` (apps/api/src/install-script.ts)
 * — the single source of truth for the installer — so the release asset and the
 * live `GET /install.sh` route never drift. The difference here is that we pin the
 * agent image to the released version (no floating `latest` in the copy/paste
 * path) and default the controller URL to a stable, overridable placeholder.
 *
 * Invoked by semantic-release's @semantic-release/exec `prepareCmd`:
 *   bun run scripts/gen-install-sh.ts <version> [outFile]
 * then @semantic-release/github attaches dist/install.sh as a release asset.
 *
 * Usage: bun run scripts/gen-install-sh.ts <version> [outFile]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderInstallScript } from '../apps/api/src/install-script';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const version = process.argv[2];
if (!version) {
  console.error('gen-install-sh: expected a version argument');
  process.exit(1);
}

const outFile = resolve(process.argv[3] ?? join(repoRoot, 'dist', 'install.sh'));

// Stable controller URL placeholder; the operator overrides via
// SWARMY_CONTROLLER_URL when they pipe the script. The image owner can be
// overridden via SWARMY_IMAGE_OWNER at generation time (defaults to requestflo,
// matching the live route + Dockerfile headers).
const controllerUrl = process.env.SWARMY_CONTROLLER_URL ?? 'http://localhost:3001';
const owner = process.env.SWARMY_IMAGE_OWNER ?? 'requestflo';

// Pin the agent image to the released version for the generated asset.
process.env.SWARMY_AGENT_IMAGE = `ghcr.io/${owner}/swarmy-agent:${version}`;

const banner = `# swarmy installer — generated for release v${version}
# Source of truth: apps/api/src/install-script.ts (do not edit by hand).
`;

const script = renderInstallScript(controllerUrl, { manager: false });
// Insert the version banner right after the shebang line.
const lines = script.split('\n');
const body = lines[0]?.startsWith('#!') ? `${lines[0]}\n${banner}${lines.slice(1).join('\n')}` : `${banner}${script}`;

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, body, { mode: 0o755 });
console.log(`gen-install-sh: wrote ${outFile} (agent image pinned to v${version})`);
