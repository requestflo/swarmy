/**
 * True when no public ACME CA could ever validate `host`: a LAN-only name, or a
 * wildcard-DNS name (sslip.io / nip.io style) that embeds a private IPv4.
 *
 * MIRRORS `isPrivateHost` in packages/ingress/src/render/caddyfile.ts — the
 * dashboard deliberately does not depend on @swarmy/ingress (server-side
 * drivers), so this tiny pure helper is duplicated. Keep the two in sync: the
 * edge serves such hosts with swarmy's local CA (`tls internal`), and the UI
 * uses this to warn that the browser will not trust that certificate at first.
 */
const PRIVATE_V4 =
  /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^169\.254\.|^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./;
const LOCAL_SUFFIXES = ['.local', '.lan', '.internal', '.home.arpa', '.test', '.localhost'];

export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || LOCAL_SUFFIXES.some((s) => h.endsWith(s))) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) return PRIVATE_V4.test(h);
  const embedded = h.match(
    /(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})\.(?:sslip\.io|nip\.io)$/,
  );
  return embedded ? PRIVATE_V4.test(embedded.slice(1, 5).join('.')) : false;
}
