import { createHash } from 'node:crypto';
import { PLACEHOLDER_EMAIL_TLD, hostPart } from './identity';

/**
 * The placeholder for an IdP account (`sub`) that came back without email.
 * The local part is a hash of the exact `providerId` + `sub`, so two
 * identities can never share an address (sanitising them did: `acme.corp`
 * and `acme_corp`, or subjects `a:1` and `a-1`, collided, and a shared
 * address is what Better Auth falls back to matching on). The host part is
 * only a readable hint.
 *
 * Accounts created before this rule keep their old `<sub>@<provider>.sso.…`
 * address: Better Auth finds a returning IdP identity by its account row
 * (providerId + accountId), never by the address, and the `.idp.` namespace
 * means a new address can't land on an old one.
 */
export function idpPlaceholderEmail(providerId: string, subject: string): string {
  const id = createHash('sha256').update(JSON.stringify([providerId, subject])).digest('hex').slice(0, 32);
  return `${id}@${hostPart(providerId)}.idp.${PLACEHOLDER_EMAIL_TLD}`;
}

