/**
 * Pinned mesh images (plans/epic-self-hosted-mesh-and-fleets.md §10: the
 * client signal-retry bug means we pin, and the control plane upgrades BEFORE
 * clients). The ONE source is @swarmy/core's SYSTEM_IMAGES BOM (`netbirdServer`,
 * `netbirdClient`, `netbirdRelay`, `tailscaleClient`, `litestream`), so platform upgrades, the
 * registry mirror and the mesh all see the same digests: bump the BOM only.
 * The installer's defaults (scripts/install-swarmy.sh) are held to it by
 * apps/api/src/install/installer-mesh-images.test.ts.
 */
import { pinnedTaggedRef, systemImage } from '@swarmy/core/system-images';

const server = systemImage('netbirdServer');
const client = systemImage('netbirdClient');
const litestream = systemImage('litestream');

/** The tag of a `repo:tag` ref. */
function tagOf(ref: string): string {
  return ref.slice(ref.lastIndexOf(':') + 1);
}

export const NETBIRD_VERSION = tagOf(server.ref);
export const NETBIRD_SERVER_REF = server.ref;
export const NETBIRD_SERVER_DIGEST = server.digest!;
export const NETBIRD_CLIENT_REF = client.ref;
export const NETBIRD_CLIENT_DIGEST = client.digest!;
export const LITESTREAM_REF = litestream.ref;
export const LITESTREAM_DIGEST = litestream.digest!;

/** `ref@digest`: what the agent pulls. */
export const NETBIRD_SERVER_IMAGE = pinnedTaggedRef('netbirdServer');
export const NETBIRD_CLIENT_IMAGE_PINNED = pinnedTaggedRef('netbirdClient');
/** The standalone relay + STUN for edge nodes ("relays on edges"). */
export const NETBIRD_RELAY_IMAGE_PINNED = pinnedTaggedRef('netbirdRelay');
export const LITESTREAM_IMAGE_PINNED = pinnedTaggedRef('litestream');
/** Headscale's client (the official tailscale image), pinned like NetBird's. */
export const TAILSCALE_CLIENT_IMAGE_PINNED = pinnedTaggedRef('tailscaleClient');
