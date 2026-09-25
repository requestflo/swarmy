# swarmy-walg — wal-g for managed Postgres PITR (base backups, WAL shipping,
# restore). wal-g publishes release BINARIES, not images (there is no
# ghcr.io/wal-g/wal-g), so swarmy builds this one from the official GitHub
# release of the Postgres build, checksum-verified. Built from THIS directory
# alone (context docker/walg).
#
# The binaries only need glibc (built on Ubuntu 20.04, glibc 2.31), so any
# newer Debian runs them. /bin/sh is required: the agent runs wal-g through
# `/bin/sh -c` (backup-push, restore scripts, the WAL-shipper loop).
FROM debian:bookworm-slim

ARG WALG_VERSION=v3.0.3
# sha256 of the release assets, taken from the release's own .sha256 files
# (and re-checked below against the one published next to each asset).
ARG WALG_SHA256_AMD64=0b46652f23fb4d09fa08f3d536b72806e597c4e20d0a09d960d6337bc2368e8b
ARG WALG_SHA256_ARM64=3aec9024959319468ac637ea4b2e215fe20511672669969077733ee5c3fd1466
ARG TARGETARCH

RUN set -eux; \
  apt-get update; \
  apt-get install -y --no-install-recommends ca-certificates curl; \
  case "${TARGETARCH:-amd64}" in \
    amd64) asset="wal-g-pg-ubuntu-20.04-amd64"; sum="${WALG_SHA256_AMD64}" ;; \
    arm64) asset="wal-g-pg-ubuntu20.04-aarch64"; sum="${WALG_SHA256_ARM64}" ;; \
    *) echo "unsupported arch ${TARGETARCH}" >&2; exit 1 ;; \
  esac; \
  base="https://github.com/wal-g/wal-g/releases/download/${WALG_VERSION}"; \
  curl -fsSL -o /usr/local/bin/wal-g "${base}/${asset}"; \
  published="$(curl -fsSL "${base}/${asset}.sha256" | awk '{print $1}')"; \
  [ "${published}" = "${sum}" ] || { echo "release checksum ${published} != pinned ${sum}" >&2; exit 1; }; \
  echo "${sum}  /usr/local/bin/wal-g" | sha256sum -c -; \
  chmod 0755 /usr/local/bin/wal-g; \
  apt-get purge -y --auto-remove curl; \
  rm -rf /var/lib/apt/lists/*; \
  wal-g --version

ENTRYPOINT ["wal-g"]
