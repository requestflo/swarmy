import { z } from 'zod';

/**
 * Per-app RUM settings (web analytics + session replay). Docker truth: the
 * JSON lives on the `swarmy.rum` label of the app's (stack's) services, like
 * `swarmy.otel.enabled` — never a DB column. The edge render reads it back
 * from the live inventory; changing it re-renders ingress, no redeploy.
 */
export const RUM_SETTINGS_LABEL = 'swarmy.rum';

/** Per-route override inside the `swarmy.ingress.routes` entry: `rum: "off"` opts a route out. */
export const RUM_ROUTE_MODES = ['on', 'off'] as const;
export type RumRouteMode = (typeof RUM_ROUTE_MODES)[number];

export const RUM_RETENTION_CHOICES = [7, 14, 30, 90] as const;
export const RUM_SAMPLE_CHOICES = [0, 0.01, 0.05, 0.1, 0.25, 1] as const;

export const RumSettingsSchema = z.object({
  /** Analytics (and, in identified mode, replay) injected on this app's routes. */
  enabled: z.boolean().default(false),
  /** `analytics` = cookieless aggregate (default); `identified` = sessions, users, replay. */
  mode: z.enum(['analytics', 'identified']).default('analytics'),
  /** Share of identified sessions recorded for replay (0 = replay off). */
  replaySampleRate: z.number().min(0).max(1).default(0),
  /** Mask all page text in replays (inputs are always masked). */
  maskAllText: z.boolean().default(false),
  /** CSS selectors never recorded (drawn as a grey box). */
  blockSelectors: z
    .array(z.string().min(1).max(200).refine((s) => !/[<>"`{}\\\n]/.test(s), 'selector must not contain < > " ` { } \\ or newlines'))
    .max(20)
    .default([]),
  /** Consent gate for identified mode. */
  consent: z.enum(['none', 'hook', 'cmp']).default('hook'),
  /** Days before analytics rows, the replay index and replay chunks are deleted. */
  retentionDays: z.number().int().min(1).max(365).default(14),
  /** CSP handling at the edge. */
  csp: z.enum(['rewrite', 'skip']).default('rewrite'),
});
export type RumSettings = z.infer<typeof RumSettingsSchema>;

export function defaultRumSettings(): RumSettings {
  return RumSettingsSchema.parse({});
}

/** Tolerant label read: a malformed label reads as "off", never throws. */
export function readRumSettings(labels: Record<string, string> | undefined): RumSettings {
  const raw = labels?.[RUM_SETTINGS_LABEL];
  if (!raw) return defaultRumSettings();
  try {
    const parsed = RumSettingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : defaultRumSettings();
  } catch {
    return defaultRumSettings();
  }
}

/** Compact, key-sorted label value (stable → no spurious service updates). */
export function serializeRumSettings(s: RumSettings): string {
  const v = RumSettingsSchema.parse(s);
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

/** Is replay effectively on (identified mode + a non-zero sample)? */
export function replayActive(s: RumSettings): boolean {
  return s.enabled && s.mode === 'identified' && s.replaySampleRate > 0;
}
