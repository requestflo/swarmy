import type { TRPCLink } from '@trpc/client';
import type { AppRouter } from '@swarmy/trpc';
import { authClient } from '@swarmy/auth/client';

/**
 * Session recovery for the dashboard. A single empty/401 answer is not proof the
 * user is signed out (a stale cookie-cache entry, a request racing a cookie
 * refresh) — so before ejecting anyone we re-ask the controller once with the
 * cookie cache bypassed, and only redirect on a confirmed signed-out state.
 */

/** True when the controller confirms a live session (one cache-bypassing retry). */
export async function hasLiveSession(): Promise<boolean> {
  const first = await authClient.getSession().catch(() => null);
  if (first?.data?.session) return true;
  const fresh = await authClient
    .getSession({ query: { disableCookieCache: true } })
    .catch(() => null);
  return Boolean(fresh?.data?.session);
}

// Single-flight: a burst of batched 401s shares one session re-check.
let inflight: Promise<boolean> | null = null;
function recoverSession(): Promise<boolean> {
  inflight ??= hasLiveSession().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Hard-navigate to /login, remembering where the user was. Idempotent. */
export function redirectToLogin(): void {
  const { pathname, search, hash } = window.location;
  if (pathname === '/login') return;
  const back = `${pathname}${search}${hash}`;
  window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
}

/**
 * On UNAUTHORIZED: re-check the session once. Still signed in → replay the
 * operation once; signed out → send the user to /login instead of letting the
 * background polls spam 401s in place. Built on the downstream observable's
 * `subscribe` only (as `demoLink` does) so the app needn't depend on @trpc/server.
 */
export function unauthorizedLink(): TRPCLink<AppRouter> {
  const link: TRPCLink<AppRouter> = () => ({ next, op }) => {
    const downstream = () => next(op);
    if (op.type === 'subscription') return downstream();
    type Observer = Parameters<ReturnType<typeof downstream>['subscribe']>[0];
    // The chain only ever calls `subscribe` on a link's observable.
    return {
      subscribe(observer: Observer) {
        let sub = downstream().subscribe({
          next: (v) => observer.next?.(v),
          complete: () => observer.complete?.(),
          error: (err) => {
            if (err.data?.code !== 'UNAUTHORIZED') {
              observer.error?.(err);
              return;
            }
            void recoverSession().then((alive) => {
              if (!alive) {
                redirectToLogin();
                observer.error?.(err);
                return;
              }
              sub = downstream().subscribe(observer);
            });
          },
        });
        return { unsubscribe: () => sub.unsubscribe() };
      },
    } as unknown as ReturnType<typeof downstream>;
  };
  return link;
}
