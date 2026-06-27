/**
 * Two-stage, checksum-pinned install loader (node-onboarding epic, PHASE-2+).
 *
 * The thing a user pipes into their shell is deliberately TINY and reviewable:
 * it does nothing but download the real, version-pinned installer, verify its
 * sha256 against a value baked into the loader, and exec it. This is what makes
 * `curl | sh` honest — a later CDN/registry compromise can't silently swap the
 * installer because the checksum is pinned in the (cacheable, signable) loader
 * body the user already read.
 *
 * Served at:
 *   GET /install/<version>/install.sh         → the real installer (big script)
 *   GET /install/<version>/install.sh.sha256  → its checksum (for manual verify)
 *   GET /install.sh                           → the loader (this module)
 *
 * Pure render + a checksum helper; unit-tested.
 */
import { createHash } from 'node:crypto';

/** sha256 hex digest of an installer body (matches the `.sha256` route output). */
export function sha256Hex(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Body of the `GET /install/<version>/install.sh.sha256` route: `<hex>  install.sh`. */
export function renderChecksumFile(installerBody: string): string {
  return `${sha256Hex(installerBody)}  install.sh\n`;
}

export interface RenderLoaderOptions {
  /** Controller public base URL (e.g. https://app.swarmy.dev). */
  controllerUrl: string;
  /** Pinned agent/installer version (path component). */
  version: string;
  /** sha256 hex of the versioned installer the loader will fetch + verify. */
  installerSha256: string;
}

/**
 * Render the tiny two-stage loader. It downloads `/install/<version>/install.sh`,
 * verifies its sha256 against the pinned value, and execs it (forwarding all
 * args + the SWARMY_* env). Fails loudly so a piped shell never runs an
 * unverified body.
 */
export function renderLoader(opts: RenderLoaderOptions): string {
  const { controllerUrl, version } = opts;
  const sha = opts.installerSha256.toLowerCase();
  const installerUrl = `${controllerUrl}/install/${version}/install.sh`;
  return `#!/usr/bin/env sh
# swarmy install loader (stage 1 of 2) — pinned: ${version}
#
# This tiny script only downloads the real, version-pinned installer and
# verifies its sha256 before running it. Review the installer it fetches at:
#   ${installerUrl}
# Verify the checksum yourself:
#   curl -fsSL ${installerUrl} | sha256sum   # expect: ${sha}
set -eu

SWARMY_INSTALLER_URL="\${SWARMY_INSTALLER_URL:-${installerUrl}}"
SWARMY_INSTALLER_SHA256="\${SWARMY_INSTALLER_SHA256:-${sha}}"

err() { printf 'swarmy: %s\\n' "$1" >&2; exit 1; }

command -v curl >/dev/null 2>&1 || err "curl is required"

# Pick a sha256 tool (Linux: sha256sum, macOS/BSD: shasum -a 256).
if command -v sha256sum >/dev/null 2>&1; then
  sha_of() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
  sha_of() { shasum -a 256 "$1" | awk '{print $1}'; }
else
  err "no sha256 tool (need sha256sum or shasum)"
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$SWARMY_INSTALLER_URL" -o "$tmp" || err "failed to download installer"

got="$(sha_of "$tmp")"
if [ "$got" != "$SWARMY_INSTALLER_SHA256" ]; then
  err "installer checksum mismatch (expected $SWARMY_INSTALLER_SHA256, got $got)"
fi

# Hand off to the verified installer, forwarding args + SWARMY_* env.
sh "$tmp" "$@"
`;
}
