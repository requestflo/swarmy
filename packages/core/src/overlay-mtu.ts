/**
 * Overlay MTU over the WireGuard mesh, from the real header sizes. PURE
 * (browser-safe): the controller, the agent and the tests share it.
 *
 * A container on a swarm overlay sends IP packets up to its interface MTU (the
 * "container MTU"). Docker wraps each one in VXLAN and, on an encrypted
 * overlay, IPsec ESP, and sends that frame out the link toward the other node.
 * On a mesh cluster that link is the WireGuard interface (NetBird `wt0`,
 * Headscale's `tailscale0`), whose MTU is 1280. A frame bigger than that
 * fragments at best and is silently dropped at worst: TLS handshakes and big
 * responses stall while pings still work.
 *
 *   VXLAN = outer IPv4 20 + UDP 8 + VXLAN 8 + the inner Ethernet header 14 = 50
 *   ESP   = SPI 4 + sequence 4 + IV 8 + pad length 1 + next header 1 + ICV 8 = 26
 *           (Docker uses rfc4106 AES-GCM with a 64-bit tag in transport mode,
 *           so there is no second IP header), plus 0–3 bytes of padding to a
 *           4-byte boundary.
 *
 * Docker reads `com.docker.network.driver.mtu` on an overlay as the MTU of that
 * LINK and takes the encapsulation off itself (libnetwork overlay `maxMTU`:
 * link − 50, and when encrypted − 26, rounded down to a multiple of 4, which
 * makes the ESP padding 0). Unset means 1500, so a default overlay gives
 * containers 1450 (1424 encrypted): 170 bytes too big for wt0.
 *
 * So a new overlay on a mesh needs the option set to the link MTU itself
 * (1280). Containers then get 1230, or 1204 encrypted, and a full-size frame is
 * exactly 1280. WireGuard's own 60 bytes ride the underlay, which is why wt0 is
 * 1280 and not 1500. (An IPv6 VTEP would add 20 more; the mesh is IPv4.)
 */

/** Docker overlay driver option carrying the link MTU (a string, per Docker). */
export const OVERLAY_MTU_OPTION = 'com.docker.network.driver.mtu';
/** What Docker assumes when the option is unset. */
export const DOCKER_DEFAULT_LINK_MTU = 1500;
/** VXLAN encapsulation (libnetwork `vxlanEncap`). */
export const VXLAN_OVERHEAD = 50;
/** ESP on an encrypted overlay, before padding (libnetwork `pktExpansion`). */
export const IPSEC_OVERHEAD = 26;

/**
 * The WireGuard interface MTU each mesh driver brings up: NetBird (`wt0`) and
 * Headscale's tailscale client (`tailscale0`) both default to 1280. `none` = no
 * mesh, so Docker's default is already right.
 */
export function meshLinkMtu(driver: string | null | undefined): number | undefined {
  switch ((driver ?? 'none').toLowerCase()) {
    case 'netbird':
    case 'headscale':
      return 1280;
    default:
      return undefined;
  }
}

/** The MTU containers on an overlay get from its option (libnetwork `maxMTU`). */
export function overlayContainerMtu(option: number | null | undefined, encrypted: boolean): number {
  let mtu = (option && option > 0 ? option : DOCKER_DEFAULT_LINK_MTU) - VXLAN_OVERHEAD;
  if (encrypted) {
    mtu -= IPSEC_OVERHEAD;
    mtu -= mtu % 4;
  }
  return mtu;
}

/** Bytes a full-size container packet takes on the link once wrapped. */
export function overlayFrameBytes(containerMtu: number, encrypted: boolean): number {
  const esp = encrypted ? IPSEC_OVERHEAD + ((4 - (containerMtu % 4)) % 4) : 0;
  return containerMtu + VXLAN_OVERHEAD + esp;
}

/**
 * The option a NEW overlay needs over a `linkMtu` path: the link MTU itself,
 * since Docker takes the VXLAN (and ESP) bytes off. `undefined` = leave
 * Docker's default (no mesh).
 */
export function overlayMtuFor(linkMtu: number | undefined): number | undefined {
  return linkMtu && linkMtu > 0 ? linkMtu : undefined;
}

/** Parse the option as Docker does (a positive integer string), else undefined. */
export function parseMtuOption(value: string | undefined | null): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return undefined;
  const n = Number(value.trim());
  return n > 0 ? n : undefined;
}
