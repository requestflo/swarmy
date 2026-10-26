/**
 * The rules previews run by — PURE. `toDesired` turns the `previews:` block
 * into `DesiredApp.previews` here and applies its per-service rules (sleep,
 * size) to every service of a preview; the dashboard reads the same defaults.
 *
 * Where the block comes from: production's swarmy.yaml when it has one (the
 * file decides), else the rules saved from the dashboard (held on the
 * production stack's services until the file names `previews:`), else the
 * defaults.
 *
 * Sleep: a preview that nobody opens shouldn't hold a server's memory. Its
 * routed services carry the scale-to-zero labels, so the idle sleeper puts
 * them to sleep once neither the edge nor the activator has seen a request
 * for `previews.sleep_after` (default 2 h), and the activator wakes them on
 * the next request. Services without an address keep what they declare:
 * nothing could wake them.
 */
import type { z } from 'zod';
import { SIZE_PRESETS, type AppConfig, type PreviewsSchema, type SizePreset } from './schema';
import { parseDuration } from './units';

export const DEFAULT_PREVIEW_TTL_SECONDS = 72 * 3600;
/** A preview's routed services sleep after this long idle unless `previews.sleep_after` says otherwise. */
export const PREVIEW_SLEEP_AFTER_SECONDS = 2 * 3600;

export type PreviewsBlock = NonNullable<AppConfig['previews']>;
export type PreviewsInput = z.input<typeof PreviewsSchema>;

export interface DesiredPreviews {
  enabled: boolean;
  ttlSeconds: number;
  baseDomain?: string;
  resources: 'isolated' | 'shared';
  branches: string[];
  data?: { from: string; scrub?: string };
  /** A preview's routed services sleep after this long idle (null = never). */
  sleepAfterSeconds: number | null;
  /** The most any one preview service gets (a size preset); absent = what the app asks for. */
  size?: SizePreset;
  /** production's swarmy.yaml, the dashboard (until the file has a previews: block), or the defaults. */
  source: 'file' | 'dashboard' | 'default';
  /** The dashboard's block as saved — re-stamped on production's services with each deploy. */
  dashboard?: PreviewsBlock;
}

/** The block that applies: the file's, else the dashboard's. */
export function previewsBlock(cfg: Pick<AppConfig, 'previews'>, dashboard?: PreviewsBlock | null): PreviewsBlock | undefined {
  return cfg.previews ?? dashboard ?? undefined;
}

/** `previews:` (the file's, else the dashboard's) → the fully-defaulted rules. */
export function desiredPreviews(cfg: Pick<AppConfig, 'previews'>, dashboard?: PreviewsBlock | null): DesiredPreviews {
  const fromDashboard = !cfg.previews && dashboard ? dashboard : undefined;
  const p = previewsBlock(cfg, dashboard);
  return {
    enabled: p?.enabled ?? false,
    ttlSeconds: p?.ttl !== undefined ? (parseDuration(p.ttl) ?? 0) : DEFAULT_PREVIEW_TTL_SECONDS,
    baseDomain: p?.base_domain,
    resources: p?.resources ?? 'isolated',
    branches: [...(p?.branches ?? [])],
    ...(p?.data ? { data: { from: p.data.from, ...(p.data.scrub ? { scrub: p.data.scrub } : {}) } } : {}),
    sleepAfterSeconds: previewIdleSeconds(p?.sleep_after),
    ...(p?.size ? { size: p.size } : {}),
    source: cfg.previews ? 'file' : fromDashboard ? 'dashboard' : 'default',
    ...(fromDashboard ? { dashboard: fromDashboard } : {}),
  };
}

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

/** `previews.size`: a preview service gets at most that preset — less when it asks for less. */
export function capToSize(r: { cpu?: number; memoryMb?: number }, size: SizePreset | undefined): { cpu?: number; memoryMb?: number } {
  if (!size) return r;
  const cap = SIZE_PRESETS[size];
  return { cpu: Math.min(r.cpu ?? cap.cpu, cap.cpu), memoryMb: Math.min(r.memoryMb ?? cap.memoryMb, cap.memoryMb) };
}
