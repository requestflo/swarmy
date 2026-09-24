/**
 * Pinned NetBird images (plans/epic-self-hosted-mesh-and-fleets.md §10: the
 * client signal-retry bug means we pin, and the control plane upgrades BEFORE
 * clients). The same refs + digests are in @swarmy/core's SYSTEM_IMAGES BOM
 * (`netbirdServer`, `netbirdClient`, `litestream`) so platform upgrades and the
 * registry mirror see them; bump both together.
 */
export const NETBIRD_VERSION = '0.79.0';
export const NETBIRD_SERVER_REF = `ghcr.io/netbirdio/netbird-server:${NETBIRD_VERSION}`;
export const NETBIRD_SERVER_DIGEST = 'sha256:d1da0c0179c9e6f2ab7b48be54d06341b11037855a9426b9f2536aa79f13360b';
export const NETBIRD_CLIENT_REF = `ghcr.io/netbirdio/netbird:${NETBIRD_VERSION}`;
export const NETBIRD_CLIENT_DIGEST = 'sha256:9d8480d87b7f7c10d67b820eecf332ecca5c2756792d4bdfa532182b4fc3005f';
export const LITESTREAM_REF = 'litestream/litestream:0.5.17';
export const LITESTREAM_DIGEST = 'sha256:4b02b9859a6b6b4087d8b8944e15f7e984bd7957cba322bbeee38b0e27b9656a';

/** `ref@digest` — what the agent pulls. */
export const NETBIRD_SERVER_IMAGE = `${NETBIRD_SERVER_REF}@${NETBIRD_SERVER_DIGEST}`;
export const NETBIRD_CLIENT_IMAGE_PINNED = `${NETBIRD_CLIENT_REF}@${NETBIRD_CLIENT_DIGEST}`;
export const LITESTREAM_IMAGE_PINNED = `${LITESTREAM_REF}@${LITESTREAM_DIGEST}`;
