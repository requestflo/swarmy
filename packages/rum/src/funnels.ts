import { z } from 'zod';

/**
 * Per-app conversion funnels. Docker truth, beside the RUM settings: the JSON
 * list lives on the `swarmy.rum.funnels` label of the app's services (every
 * one of them, like `swarmy.rum`). Unlike the settings it never reaches the
 * edge, so saving it re-renders nothing; only the reads use it.
 *
 * A step is a page path pattern (`*` matches any run of characters, the rest
 * is literal) and, optionally, a custom event fired on that page
 * (`window.__swarmy.track(name)` → a `kind = 'ev'` row with `event_name`).
 */
export const RUM_FUNNELS_LABEL = 'swarmy.rum.funnels';

export const MAX_FUNNELS = 5;
export const MIN_FUNNEL_STEPS = 2;
export const MAX_FUNNEL_STEPS = 8;
export const FUNNEL_WINDOW_CHOICES = [30, 60, 1440] as const;

/** `/checkout`, `/product/*`, `/*`: starts with `/`, no quotes, spaces or backslashes. */
export const FunnelPathSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^\/[^\s'"`\\<>]*$/, 'a path starts with / and has no spaces, quotes or backslashes')
  .transform((p) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p));

export const FunnelStepSchema = z.object({
  /** What the step is called on screen ("checkout"); derived from the path or event when absent. */
  name: z.string().trim().max(40).optional(),
  path: FunnelPathSchema,
  /** A custom event name; the step then needs that event on a matching page. */
  event: z
    .string()
    .trim()
    .max(80)
    .regex(/^[\w.:\- ]+$/, 'letters, digits, space and . : - _ only')
    .optional(),
});
export type FunnelStep = z.infer<typeof FunnelStepSchema>;

export const FunnelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'lowercase letters, digits and -'),
  name: z.string().trim().min(1).max(60),
  steps: z.array(FunnelStepSchema).min(MIN_FUNNEL_STEPS).max(MAX_FUNNEL_STEPS),
  /** How long a visit has to get from the first step to the last. */
  windowMinutes: z.number().int().min(5).max(7 * 1440).default(60),
});
export type Funnel = z.infer<typeof FunnelSchema>;

export const FunnelsSchema = z
  .array(FunnelSchema)
  .max(MAX_FUNNELS)
  .refine((fs) => new Set(fs.map((f) => f.id)).size === fs.length, 'funnel ids must be unique');

/** Tolerant label read: a malformed label reads as "no funnels", never throws. */
export function readRumFunnels(labels: Record<string, string> | undefined): Funnel[] {
  const raw = labels?.[RUM_FUNNELS_LABEL];
  if (!raw) return [];
  try {
    const parsed = FunnelsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

/** Compact label value, fields in a fixed order (stable → no spurious service updates). */
export function serializeRumFunnels(funnels: Funnel[]): string {
  const v = FunnelsSchema.parse(funnels);
  return JSON.stringify(
    v.map((f) => ({
      id: f.id,
      name: f.name,
      steps: f.steps.map((s) => ({ ...(s.name ? { name: s.name } : {}), path: s.path, ...(s.event ? { event: s.event } : {}) })),
      windowMinutes: f.windowMinutes,
    })),
  );
}

/** "checkout" for `/checkout/*`, the event name when there is one, "home" for `/`. */
export function funnelStepName(step: FunnelStep): string {
  if (step.name) return step.name;
  if (step.event) return step.event;
  const parts = step.path.split('/').filter((p) => p && !p.includes('*'));
  return parts.at(-1) ?? (step.path === '/' ? 'home' : 'any page');
}
