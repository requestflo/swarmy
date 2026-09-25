/**
 * The node installer's download integrity (security review H17), as POSIX sh
 * spliced into the stage-2 installer (./installer.ts). Kept in its own module
 * so tests can source it and run the real functions.
 *
 * 1. Transport: every URL the installer fetches must be `https://`. The only
 *    plain-HTTP exceptions are the node-local bootstrap (a loopback
 *    controller: the controller host itself, a dev controller) and an explicit
 *    `SWARMY_ALLOW_INSECURE=1` (the controller operator's opt-in, baked by the
 *    loader). curl runs with `--proto =https` and `--proto-redir =https`, so a
 *    redirect can never downgrade a download to HTTP.
 *
 * 2. Content: the installer fetches the signed release manifest
 *    (`/install/release/platform.json` + `.sig`, see ./release.ts) and
 *    verifies it OFFLINE with the swarmy release public key — the operator's
 *    `SWARMY_RELEASE_PUBKEY` / `--release-pubkey` (PEM or a file), else the key
 *    the controller baked into this installer. Same check as
 *    `packages/core/src/platform-verify.ts`: an ECDSA-P256/SHA-256 (cosign key
 *    pair) or Ed25519 signature over the canonical manifest bytes, checked
 *    with openssl. Then:
 *      - the agent binary must match the manifest's `agentBinaries[platform]`
 *        (and the controller's own pin, when it has one);
 *      - the container backend pulls the agent image BY the manifest's digest.
 *    A manifest that does not verify is fatal: nothing is installed.
 *
 * 3. Fallback: no release key configured yet (or no signed manifest for this
 *    build) ⇒ the checksum the controller pins, with a clear warning. An
 *    operator who passed `SWARMY_RELEASE_PUBKEY` explicitly gets no fallback.
 *
 * Expects `say`/`ok`/`warn`/`die`/`have` and `CONTROLLER_URL` from the
 * installer, and `BAKED_RELEASE_PUBKEY_B64` (possibly empty).
 */
export const RELEASE_VERIFY_SH = `# --- download integrity (security review H17) ---------------------------------
# Loopback is the node-local bootstrap: nothing crosses a network.
is_loopback_url() {
  _h="\${1#*://}"; _h="\${_h%%/*}"
  case "$_h" in
    \\[*\\]*) _h="\${_h%%]*}]" ;;
    *) _h="\${_h%%:*}" ;;
  esac
  [ "$_h" = localhost ] || [ "$_h" = "[::1]" ] && return 0
  printf '%s' "$_h" | grep -Eq '^127\\.[0-9]{1,3}\\.[0-9]{1,3}\\.[0-9]{1,3}$'
}

url_secure() {
  case "$1" in
    https://*) return 0 ;;
    http://*) is_loopback_url "$1" && return 0; [ "\${SWARMY_ALLOW_INSECURE:-0}" = 1 ] ;;
    *) return 1 ;;
  esac
}

# require_secure_url URL WHAT
require_secure_url() {
  url_secure "$1" || die "$2 must be an https:// address (got $1). Over plain HTTP anyone on the network path can swap what gets installed. Use the controller's HTTPS address, or — only on a network you trust — set SWARMY_ALLOW_INSECURE=1."
  case "$1" in
    http://*) is_loopback_url "$1" || warn "INSECURE: $2 is plain HTTP ($1) because SWARMY_ALLOW_INSECURE=1. Anyone on the network path can tamper with this install." ;;
  esac
}

# fetch URL OUT — HTTPS only (redirects too), except the documented exceptions above.
fetch() {
  url_secure "$1" || die "refusing to download over plain HTTP: $1"
  case "$1" in
    https://*) curl -fsSL --proto '=https' --proto-redir '=https' "$1" -o "$2" ;;
    *) curl -fsSL --proto '=http,https' --proto-redir '=https' "$1" -o "$2" ;;
  esac
}

RELEASE_STATE=none
RELEASE_MANIFEST=""

# release_key_file OUT → 0 with the PEM written, 1 when no key is configured.
release_key_file() {
  _k="\${SWARMY_RELEASE_PUBKEY:-}"
  if [ -n "$_k" ]; then
    case "$_k" in
      *"-----BEGIN"*) printf '%s\\n' "$_k" > "$1" ;;
      *) [ -r "$_k" ] || die "SWARMY_RELEASE_PUBKEY / --release-pubkey must be a PEM public key or a readable file holding one."; cat "$_k" > "$1" ;;
    esac
    return 0
  fi
  [ -n "\${BAKED_RELEASE_PUBKEY_B64:-}" ] || return 1
  printf '%s' "$BAKED_RELEASE_PUBKEY_B64" | base64 -d > "$1" 2>/dev/null
}

# verify_release_sig KEY MANIFEST SIG_B64 → 0 when the signature matches.
verify_release_sig() {
  _der="$(mktemp)"
  if ! tr -d ' \\n\\r\\t' < "$3" | base64 -d > "$_der" 2>/dev/null || [ ! -s "$_der" ]; then rm -f "$_der"; return 1; fi
  if openssl pkey -pubin -in "$1" -noout -text 2>/dev/null | grep -qi 'ED25519'; then
    openssl pkeyutl -verify -pubin -inkey "$1" -rawin -in "$2" -sigfile "$_der" >/dev/null 2>&1
  else
    openssl dgst -sha256 -verify "$1" -signature "$_der" "$2" >/dev/null 2>&1
  fi
  _rc=$?
  rm -f "$_der"
  return $_rc
}

# load_release — fetch + verify the signed release manifest for this build.
load_release() {
  RELEASE_STATE=none
  _rdir="$(mktemp -d)"
  _rm="$_rdir/platform.json"; _rs="$_rdir/platform.json.sig"; _rk="$_rdir/release.pub"
  _explicit_key="\${SWARMY_RELEASE_PUBKEY:-}"
  if ! fetch "$CONTROLLER_URL/install/release/platform.json" "$_rm" 2>/dev/null || ! fetch "$CONTROLLER_URL/install/release/platform.json.sig" "$_rs" 2>/dev/null; then
    [ -z "$_explicit_key" ] || die "SWARMY_RELEASE_PUBKEY is set, but the controller has no signed release manifest for this build to check the download against. Check the release in Settings → Platform (or import the offline bundle), then re-run."
    warn "UNVERIFIED RELEASE: the controller has no signed release manifest for this build, so the agent is checked only against the checksum the controller serves. Check the feed in Settings → Platform to enable signed verification."
    return 0
  fi
  if ! release_key_file "$_rk"; then
    RELEASE_STATE=unverified
    warn "UNVERIFIED RELEASE: no swarmy release key is configured yet, so the signed release manifest cannot be checked — the agent is verified only against the checksum the controller serves. Pass --release-pubkey <file|pem> (SWARMY_RELEASE_PUBKEY) to verify it."
    return 0
  fi
  have openssl || die "openssl is required to verify the signed release manifest (install it, e.g. apt-get install -y openssl, then re-run)."
  verify_release_sig "$_rk" "$_rm" "$_rs" || die "The release manifest's signature does NOT match the swarmy release key. Refusing to install: the download may have been tampered with."
  RELEASE_STATE=verified
  RELEASE_MANIFEST="$_rm"
  ok "Release manifest verified with the swarmy release key."
}

# release_binary_sha PLATFORM → the signed sha256 of that agent binary (or nothing).
release_binary_sha() {
  [ "$RELEASE_STATE" = verified ] || return 0
  grep -o "\\"$1\\":{\\"sha256\\":\\"[a-f0-9]\\{64\\}\\"" "$RELEASE_MANIFEST" | head -n1 | sed 's/.*"\\([a-f0-9]\\{64\\}\\)"$/\\1/'
}

# release_agent_image → "<image> <digest>" of the signed agent component (or nothing).
release_agent_image() {
  [ "$RELEASE_STATE" = verified ] || return 0
  grep -o '"agent":{"digest":"sha256:[a-f0-9]\\{64\\}","image":"[^"]*"' "$RELEASE_MANIFEST" | head -n1 \\
    | sed 's/^"agent":{"digest":"\\(sha256:[a-f0-9]*\\)","image":"\\([^"]*\\)"$/\\2 \\1/'
}

# pinned_binary_sha PLATFORM CONTROLLER_SHA → the sha256 to check the download against.
pinned_binary_sha() {
  _signed="$(release_binary_sha "$1")"
  if [ -n "$_signed" ]; then
    [ -z "$2" ] || [ "$2" = "$_signed" ] || die "The controller pins a different agent binary for $1 ($2) than the signed release ($_signed). Refusing to install."
    echo "$_signed"
    return 0
  fi
  [ "$RELEASE_STATE" != verified ] || warn "The signed release lists no agent binary for $1; checking it against the controller's checksum only."
  echo "$2"
}

# image_repo REF → the repository without tag or digest.
image_repo() {
  _r="\${1%@*}"
  case "\${_r##*/}" in *:*) _r="\${_r%:*}" ;; esac
  echo "$_r"
}

# pin_agent_image — rewrite AGENT_IMAGE to the signed digest when it is the release's image.
pin_agent_image() {
  _sig="$(release_agent_image)"
  if [ -z "$_sig" ]; then
    [ "$RELEASE_STATE" != verified ] || warn "The signed release does not pin an agent image digest; pulling $AGENT_IMAGE unverified."
    [ "$RELEASE_STATE" = verified ] || warn "Agent image $AGENT_IMAGE is not pinned by a verified digest."
    return 0
  fi
  _img="\${_sig% *}"; _dig="\${_sig#* }"
  if [ "$(image_repo "$AGENT_IMAGE")" != "$_img" ]; then
    warn "Agent image $AGENT_IMAGE is not the one in the signed release ($_img); pulling it unverified."
    return 0
  fi
  case "$AGENT_IMAGE" in
    *@sha256:*) [ "\${AGENT_IMAGE##*@}" = "$_dig" ] || die "Agent image $AGENT_IMAGE is pinned to a different digest than the signed release ($_dig). Refusing to install." ;;
  esac
  AGENT_IMAGE="$_img@$_dig"
  ok "Agent image pinned by the signed release: $AGENT_IMAGE"
}
`;
