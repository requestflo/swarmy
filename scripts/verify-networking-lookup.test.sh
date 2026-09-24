#!/usr/bin/env bash
# Regression test for verify-networking.sh's `lookup_cmd`: bare service names
# must resolve through Docker's embedded DNS even when the host (and so every
# container's resolv.conf) carries a DNS search domain. Needs a local docker.
#
#   bash scripts/verify-networking-lookup.test.sh
#   IMAGES="busybox:1.36 alpine:latest" bash scripts/verify-networking-lookup.test.sh
#
# Uses a user-defined bridge network (same embedded 127.0.0.11 resolver as a
# swarm overlay) and `--dns-search`. Each image is checked twice: as-is (the
# getent path where the image has one) and with getent hidden (the busybox
# nslookup path). Cleans up after itself.
set -euo pipefail
cd "$(dirname "$0")"

# Pull in just the helper under test.
eval "$(sed -n '/^# >>> lookup_cmd/,/^# <<< lookup_cmd/p' verify-networking.sh)"
declare -F lookup_cmd >/dev/null || { echo "FAIL could not extract lookup_cmd"; exit 1; }

NET="swarmy-lookup-test-$$"
fails=0
cleanup() {
  docker rm -f "$NET-web" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker network create "$NET" >/dev/null
IMAGES="${IMAGES:-busybox:1.36 alpine:latest}"
first="${IMAGES%% *}"
docker run -d --name "$NET-web" --network "$NET" --network-alias web "$first" sleep 300 >/dev/null

# Hide getent: a PATH of busybox applets only, so the nslookup branch runs.
NO_GETENT='d=/tmp/nogetent; mkdir -p $d; for a in sh awk grep head nslookup; do ln -sf /bin/busybox $d/$a; done; PATH=$d; export PATH;'

check() { # check IMAGE MODE(as-is|no-getent) NAME WANT(yes|no)
  local out pre=''
  [ "$2" = no-getent ] && pre="$NO_GETENT"
  out="$(docker run --rm --network "$NET" --dns-search corp.example.invalid --dns-option ndots:5 "$1" \
    sh -c "$pre $(lookup_cmd "$3")" 2>/dev/null || true)"
  if { [ "$4" = yes ] && [ -n "$out" ]; } || { [ "$4" = no ] && [ -z "$out" ]; }; then
    echo "PASS $1 ($2) lookup '$3' -> $(echo ${out:-<none>})"
  else
    echo "FAIL $1 ($2) lookup '$3' -> '$(echo ${out:-<none>})' (want resolved=$4)"; fails=$((fails + 1))
  fi
}

for img in $IMAGES; do
  for mode in as-is no-getent; do
    check "$img" "$mode" web yes
    check "$img" "$mode" web. yes
    check "$img" "$mode" nope-not-a-service no
  done
done

# The old probe, for contrast: busybox nslookup of the bare name under a search domain.
old="$(docker run --rm --network "$NET" --dns-search corp.example.invalid --dns-option ndots:5 "$first" \
  sh -c "$NO_GETENT nslookup web 2>/dev/null | grep -c '^Name:'" 2>/dev/null || true)"
echo "INFO old probe ('nslookup web', search domain set) Name lines: ${old:-0}"

[ "$fails" = 0 ] || { echo "$fails failure(s)"; exit 1; }
echo "all lookups OK"
