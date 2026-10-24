#!/bin/sh
# Bundle DB-IP "IP to Country Lite" (CC BY 4.0) into an image at build time —
# the GeoIP floor shared by swarmy-dns (apps/dns/Dockerfile, country steering)
# and swarmy's Caddy edge (docker/caddy-swarmy/Dockerfile, country allow/deny
# rules). One script, so both images ship the same edition and attribution.
#
#   bundle-dbip-country.sh <out-dir> <consumer-sentence>
#
# Env: DBIP_MONTH=YYYY-MM pins an edition; default = this month, else last month
# (DB-IP publishes early in the month). BUNDLE=0 skips the bundle (local dev
# builds). A build with neither edition reachable FAILS rather than silently
# shipping without the floor.
set -eu
out="$1"
consumer="$2"
mkdir -p "$out"
if [ "${BUNDLE:-1}" = "0" ]; then echo "geoip bundle skipped"; exit 0; fi
if [ -n "${DBIP_MONTH:-}" ]; then months="$DBIP_MONTH"; else
  y=$(date -u +%Y); m=$(date -u +%m); m=${m#0}
  py=$y; pm=$((m - 1)); if [ "$pm" -eq 0 ]; then pm=12; py=$((y - 1)); fi
  months="$(printf '%s-%02d' "$y" "$m") $(printf '%s-%02d' "$py" "$pm")"
fi
for ym in $months; do
  if wget -q -T 120 -O /tmp/db.mmdb.gz "https://download.db-ip.com/free/dbip-country-lite-$ym.mmdb.gz"; then
    gunzip -c /tmp/db.mmdb.gz > "$out/dbip-country-lite.mmdb" && echo "$ym" > "$out/EDITION" && break
  fi
done
rm -f /tmp/db.mmdb.gz
test -s "$out/dbip-country-lite.mmdb" || { echo "no DB-IP Country Lite edition reachable ($months)"; exit 1; }
printf '%s\n' \
  'IP Geolocation by DB-IP (https://db-ip.com)' \
  '' \
  "This image bundles DB-IP \"IP to Country Lite\" (edition $(cat "$out/EDITION"))," \
  'licensed under the Creative Commons Attribution 4.0 International License' \
  '(CC BY 4.0, https://creativecommons.org/licenses/by/4.0/).' \
  "The database is redistributed unmodified; $consumer" > "$out/NOTICE"
