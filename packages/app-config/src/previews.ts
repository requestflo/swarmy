/**
 * The rules a preview runs by that aren't the app's own: when its routed
 * services sleep. PURE — `toDesired` applies them to every service of a
 * preview, and the dashboard reads the same defaults.
 *
 * Sleep: a preview that nobody opens shouldn't hold a server's memory. Its
 * routed services carry the scale-to-zero labels, so the idle sleeper puts
 * them to sleep once neither the edge nor the activator has seen a request
 * for `previews.sleep_after` (default 2 h), and the activator wakes them on
 * the next request. Services without an address keep what they declare:
 * nothing could wake them.
 */
import { parseDuration } from './units';

/** A preview's routed services sleep after this long idle unless `previews.sleep_after` says otherwise. */
export const PREVIEW_SLEEP_AFTER_SECONDS = 2 * 3600;

/** `previews.sleep_after` → seconds; `null` = never (`sleep_after: never`). */
export function previewIdleSeconds(sleepAfter: string | number | undefined): number | null {
  if (sleepAfter === 'never') return null;
  if (sleepAfter === undefined) return PREVIEW_SLEEP_AFTER_SECONDS;
  return parseDuration(sleepAfter) ?? PREVIEW_SLEEP_AFTER_SECONDS;
}

/**
 * How long a preview's service may sit idle before it sleeps, or undefined
 * to keep it up. A service with an address (what wakes it): the app's
 * `previews.sleep_after` when it sets one (never = never), else the
 * service's own `sleep_after`, else 2 h. Without an address only its own
 * `sleep_after` counts, as in production.
 */
export function previewSleepSeconds(input: {
  /** `previews.sleep_after` as written (undefined = not set). */
  previewsSleepAfter: string | number | undefined;
  /** The service's own `sleep_after`, in seconds. */
  serviceSleepSeconds: number | undefined;
  routed: boolean;
}): number | undefined {
  if (!input.routed) return input.serviceSleepSeconds;
  if (input.previewsSleepAfter !== undefined) return previewIdleSeconds(input.previewsSleepAfter) ?? undefined;
  return input.serviceSleepSeconds ?? PREVIEW_SLEEP_AFTER_SECONDS;
}
