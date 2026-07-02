/**
 * Inbound webhook dispatch worker (spine stub — owned by slice B4 webhook-gateway).
 *
 * Will deliver pending `InboundDelivery` rows each tick: queue targets via
 * RPUSH/BullMQ-add exec on the cache cluster, forward targets via POST to
 * controller-reachable URLs — with retry/backoff, dead-lettering after N
 * attempts, and replay support. Inert until B4 fills in the tick body.
 */

const TICK_MS = 30_000;

export function startInboundWebhookDispatch(): () => void {
  const timer = setInterval(() => {
    // Inert spine stub: slice B4 (webhook-gateway) implements the dispatch tick.
  }, TICK_MS);
  return () => clearInterval(timer);
}
