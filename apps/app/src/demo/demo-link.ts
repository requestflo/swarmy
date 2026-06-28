import type { TRPCLink } from '@trpc/client';
import type { AppRouter } from '@swarmy/trpc';
import { getStore } from './store';
import { HANDLERS, SUBSCRIPTIONS } from './registry';
import { fallback } from './fallback';

/**
 * A terminating tRPC link that resolves every operation from the in-memory demo
 * store instead of the network — no DB, no API, no auth. Queries/mutations emit a
 * single data event (with a touch of latency so loading states show); subscriptions
 * emit `started` then stream from a sub-resolver if one exists.
 *
 * We implement a tiny observable here (rather than depend on @trpc/server) — the
 * client only needs `.subscribe(observer) → { unsubscribe }`. The emitted shape is
 * the minimal `{ result: { type, data } }` the client consumes (no transformer,
 * since we bypass HTTP entirely).
 */
interface Observer {
  next(value: unknown): void;
  error(err: unknown): void;
  complete(): void;
}
type Teardown = () => void;

function demoObservable(producer: (obs: Observer) => Teardown | void) {
  return {
    subscribe(observer: Partial<Observer>) {
      const obs: Observer = {
        next: (v) => observer.next?.(v),
        error: (e) => observer.error?.(e),
        complete: () => observer.complete?.(),
      };
      const teardown = producer(obs);
      return {
        unsubscribe() {
          teardown?.();
        },
      };
    },
  };
}

export function demoLink(): TRPCLink<AppRouter> {
  const link =
    () =>
    ({ op }: { op: { path: string; type: 'query' | 'mutation' | 'subscription'; input: unknown } }) =>
      demoObservable((observer) => {
        const store = getStore();
        const { path, type, input } = op;

        if (type === 'subscription') {
          observer.next({ result: { type: 'started' } });
          const sub = SUBSCRIPTIONS[path];
          if (!sub) return () => undefined;
          return sub(input, store, (data) => observer.next({ result: { type: 'data', data } }));
        }

        let cancelled = false;
        const timer = setTimeout(
          () => {
            if (cancelled) return;
            try {
              const handler = HANDLERS[path];
              const data = handler ? handler(input, store) : fallback(path, input);
              observer.next({ result: { type: 'data', data } });
              observer.complete();
            } catch (err) {
              observer.error(err);
            }
          },
          70 + Math.floor(Math.random() * 80),
        );
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      });

  return link as unknown as TRPCLink<AppRouter>;
}
