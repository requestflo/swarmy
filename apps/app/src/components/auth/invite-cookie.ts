import { INVITE_COOKIE } from '@swarmy/auth/client';

/**
 * While an invite link is open, park its id in a cookie so whichever sign-in
 * follows (password, username, social, SSO: the latter leave the page) is
 * admitted and redeems it server-side. Short-lived; cleared once accepted.
 */
export function setInviteCookie(inviteId: string): void {
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${INVITE_COOKIE}=${encodeURIComponent(inviteId)}; Path=/; Max-Age=1800; SameSite=Lax${secure}`;
}

export function clearInviteCookie(): void {
  document.cookie = `${INVITE_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
}
