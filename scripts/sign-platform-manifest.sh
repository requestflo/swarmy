#!/usr/bin/env bash
# sign-platform-manifest.sh MANIFEST — sign the platform manifest with the
# swarmy release key (cosign key pair, no transparency log: controllers verify
# offline) and refuse to leave anything publishable behind unless the
# signature is real.
#
#   SWARMY_RELEASE_KEY   cosign private key (PEM), from the repo secret
#   COSIGN_PASSWORD      its password
#
# Fails LOUDLY (exit 1, GitHub ::error::) when the key is missing or the
# signature comes out empty. It never writes an empty .sig: publishing one made
# the feed upload die with "Bad Content-Length" (QA-019), and an unsigned
# manifest must never reach the feed anyway.
set -euo pipefail

manifest="${1:?usage: sign-platform-manifest.sh platform.json}"
sig="${manifest}.sig"
rm -f "$sig"

fail() {
  echo "::error title=platform manifest not signed::$*" >&2
  rm -f "$sig"
  exit 1
}

[ -s "$manifest" ] || fail "$manifest is missing or empty."
if [ -z "${SWARMY_RELEASE_KEY:-}" ]; then
  fail "the SWARMY_RELEASE_KEY secret is not set, so the manifest cannot be signed and is NOT published. Add the release key (cosign generate-key-pair; private key as SWARMY_RELEASE_KEY, its password as SWARMY_RELEASE_KEY_PASSWORD) and re-run."
fi

cosign sign-blob --yes --key env://SWARMY_RELEASE_KEY --tlog-upload=false \
  --output-signature "$sig" "$manifest" \
  || fail "cosign sign-blob failed (wrong SWARMY_RELEASE_KEY_PASSWORD?)."
[ -s "$sig" ] || fail "cosign produced an empty signature."
echo "signed $manifest ($(wc -c < "$sig" | tr -d ' ') byte signature)"
