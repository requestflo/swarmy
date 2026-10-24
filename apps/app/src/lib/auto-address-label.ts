/**
 * How the dashboard names an automatic address, honestly: one under a free
 * wildcard-IP service (sslip.io, nip.io) is a *public convenience name*, a
 * third party swarmy doesn't run; one in the org's cluster zone or its own
 * zone is answered by its own servers (plans/self-reliance.md B2b).
 */
const PUBLIC_WILDCARD = /\.(sslip|nip)\.io$/;

export function autoAddressLabel(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '');
  const svc = h.match(PUBLIC_WILDCARD);
  return svc ? `public convenience name · ${svc[1]}.io` : 'automatic address';
}
