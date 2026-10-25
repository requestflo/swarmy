/**
 * Pure: Renew now, said (board 30): what it spends, what happens while it
 * runs, and why it is not offered when it isn't.
 */
import type { CertFacts } from './cert-facts-model';

/** Why Renew now spends something, said before anyone presses it. */
export const RENEW_COST =
  "Renewing early spends one of your 5-a-week Let's Encrypt certificates for this name, so swarmy allows it once an hour and three times a week.";

/** What happens when it runs. */
export const RENEW_WHAT =
  'This address stops answering HTTPS on its front door for up to two minutes while the new certificate is issued. If none comes, the current one is put back and keeps serving.';

/** The line under Renew now when it is not offered: the reason, and when it opens again. */
export function renewBlockedLine(renew: CertFacts['renew'], now = Date.now()): string | null {
  if (renew.available) return null;
  if (!renew.retryAt) return renew.reason;
  const at = new Date(renew.retryAt);
  const when =
    at.getTime() - now < 86_400_000
      ? at.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC'
      : at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${renew.reason} Again from ${when}.`;
}

/** The toast after a renew: good news, or the old certificate is back. */
export function renewOutcomeTone(outcome: 'renewed' | 'restored' | 'failed'): 'success' | 'info' | 'error' {
  return outcome === 'renewed' ? 'success' : outcome === 'restored' ? 'info' : 'error';
}
