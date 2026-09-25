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
import { assertSafeInstallVersion } from './version-guard';
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
  /**
   * Default controller base URL baked into the loader (e.g. https://app.swarmy.dev).
   * The route resolves it from CONTROLLER_PUBLIC_URL, or — when that's unset /
   * loopback — from the address the request actually reached us at. The
   * one-liner's `--controller <base>` (or SWARMY_CONTROLLER_URL) always wins.
   */
  controllerUrl: string;
  /** Pinned agent/installer version (path component). */
  version: string;
  /** sha256 hex of the versioned installer the loader will fetch + verify. */
  installerSha256: string;
  /**
   * An operator-configured agent-binary base (SWARMY_AGENT_BINARY_BASE_URL,
   * e.g. a CDN). Omitted ⇒ derived from the controller base at run time.
   */
  binaryBaseUrl?: string;
  /**
   * The controller operator opted into plain-HTTP installs
   * (`SWARMY_ALLOW_INSECURE_INSTALL=1`, see ./transport.ts). Baked as the
   * default for `SWARMY_ALLOW_INSECURE`; otherwise only HTTPS (and the
   * loopback node-local bootstrap) is accepted.
   */
  allowInsecure?: boolean;
}

/** Single-quote a value for safe embedding in a POSIX sh script. */
function shq(v: string): string {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}

/**
 * Render the tiny two-stage loader. It resolves ONE controller base URL
 * (`--controller <base>` › `SWARMY_CONTROLLER_URL` › the baked default),
 * derives every later-stage URL from it (installer, agent binaries, the
 * agent's own dial-back), downloads `/install/<version>/install.sh`, verifies
 * its sha256 against the pinned value, and execs it (forwarding the remaining
 * args + the SWARMY_* env). Fails loudly so a piped shell never runs an
 * unverified body.
 */
export function renderLoader(opts: RenderLoaderOptions): string {
  const version = assertSafeInstallVersion(opts.version);
  const controllerUrl = opts.controllerUrl.replace(/\/+$/, '');
  const sha = opts.installerSha256.toLowerCase();
  const installerPath = `/install/${version}/install.sh`;
  const binaryDefault = opts.binaryBaseUrl ? shq(opts.binaryBaseUrl) : '"$SWARMY_CONTROLLER_URL/install/bin"';
  return `#!/usr/bin/env sh
# swarmy install loader (stage 1 of 2) — pinned: ${version}
#
# Usage: curl -fsSL <controller>/install/loader.sh | SWARMY_JOIN_TOKEN=… sh -s -- --controller <controller>
# This tiny script only downloads the real, version-pinned installer and
# verifies its sha256 before running it. Every later URL (installer, agent
# binary, the agent's dial-back) derives from the ONE controller base below.
# Verify the checksum yourself:
#   curl -fsSL ${controllerUrl}${installerPath} | sha256sum   # expect: ${sha}
set -eu

err() { printf 'swarmy: %s\\n' "$1" >&2; exit 1; }

# --controller <url> / --token <tok> are consumed here; other args are forwarded.
_want=""
for _a do
  shift
  case "$_want" in
    controller) SWARMY_CONTROLLER_URL="$_a"; _want=""; continue ;;
    token) SWARMY_JOIN_TOKEN="$_a"; _want=""; continue ;;
  esac
  case "$_a" in
    --controller) _want=controller ;;
    --controller=*) SWARMY_CONTROLLER_URL="\${_a#--controller=}" ;;
    --token) _want=token ;;
    --token=*) SWARMY_JOIN_TOKEN="\${_a#--token=}" ;;
    *) set -- "$@" "$_a" ;;
  esac
done
[ -z "$_want" ] || err "--$_want needs a value"

SWARMY_CONTROLLER_URL=\${SWARMY_CONTROLLER_URL:-${shq(controllerUrl)}}
SWARMY_CONTROLLER_URL="\${SWARMY_CONTROLLER_URL%/}"
SWARMY_ALLOW_INSECURE="\${SWARMY_ALLOW_INSECURE:-${opts.allowInsecure ? 1 : 0}}"
# Loopback = the node-local bootstrap (the controller host itself): nothing
# crosses a network, so plain HTTP is fine there.
_loopback=""
_h="\${SWARMY_CONTROLLER_URL#*://}"; _h="\${_h%%/*}"
case "$_h" in \\[*) _h="\${_h%%]*}]" ;; *) _h="\${_h%%:*}" ;; esac
if [ "$_h" = localhost ] || [ "$_h" = "[::1]" ] || printf '%s' "$_h" | grep -Eq '^127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$'; then
  _loopback=1
  printf 'swarmy: warning: controller URL %s is loopback; pass --controller <reachable-url> if this is a different machine\\n' "$SWARMY_CONTROLLER_URL" >&2
fi
case "$SWARMY_CONTROLLER_URL" in
  https://*) ;;
  http://*)
    if [ -n "$_loopback" ]; then :
    elif [ "$SWARMY_ALLOW_INSECURE" = 1 ]; then
      printf 'swarmy: WARNING: INSECURE install over plain HTTP (%s). Anyone on the network path can tamper with it. Give the controller an HTTPS address to fix this.\\n' "$SWARMY_CONTROLLER_URL" >&2
    else
      err "the controller URL must be https:// (got $SWARMY_CONTROLLER_URL). Over plain HTTP anyone on the network path can swap the installer. Use the controller's HTTPS address${controllerUrl.startsWith('https://') ? ` (${controllerUrl})` : ''}, or — only on a network you trust — set SWARMY_ALLOW_INSECURE=1."
    fi ;;
  *) err "controller URL must start with https:// (got: $SWARMY_CONTROLLER_URL)" ;;
esac
SWARMY_INSTALLER_URL="\${SWARMY_INSTALLER_URL:-$SWARMY_CONTROLLER_URL${installerPath}}"
SWARMY_INSTALLER_SHA256="\${SWARMY_INSTALLER_SHA256:-${sha}}"
SWARMY_BINARY_BASE_URL=\${SWARMY_BINARY_BASE_URL:-${binaryDefault}}
export SWARMY_CONTROLLER_URL SWARMY_BINARY_BASE_URL SWARMY_ALLOW_INSECURE
[ -z "\${SWARMY_JOIN_TOKEN:-}" ] || export SWARMY_JOIN_TOKEN

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
# Redirects may only go to HTTPS; an https:// URL never falls back to HTTP.
case "$SWARMY_INSTALLER_URL" in
  https://*) _proto='=https' ;;
  *) _proto='=http,https' ;;
esac
curl -fsSL --proto "$_proto" --proto-redir '=https' "$SWARMY_INSTALLER_URL" -o "$tmp" || err "failed to download installer from $SWARMY_INSTALLER_URL"

got="$(sha_of "$tmp")"
if [ "$got" != "$SWARMY_INSTALLER_SHA256" ]; then
  err "installer checksum mismatch (expected $SWARMY_INSTALLER_SHA256, got $got)"
fi

# Hand off to the verified installer, forwarding args + SWARMY_* env.
sh "$tmp" "$@"
`;
}
