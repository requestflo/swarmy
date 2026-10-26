/**
 * Preview rules saved from the dashboard (board 68) — PURE. The file decides:
 * while production's swarmy.yaml has a `previews:` block the dashboard only
 * shows the YAML to change (swarmy has no git write path). Without one, the
 * rules live ON the production stack — one JSON label, `swarmy.previews.rules`,
 * on each of its services (docker-native-storage: stack-level config). Every
 * plan reads them back live (`readDashboardPreviews` → `toDesired`'s
 * `dashboardPreviews`), and production's compose re-stamps them
 * (`previewRulesLabels`), so a redeploy never drops what was saved. Once the
 * file names `previews:` the next production deploy leaves the label off.
 */
import {
  DEFAULT_PREVIEW_TTL_SECONDS,
  PRODUCTION,
  PreviewsSchema,
  desiredPreviews,
  type DesiredApp,
  type PreviewsBlock,
} from '@swarmy/app-config';
import { APP_STACK_LABEL } from './live';

export const PREVIEW_RULES_LABEL = 'swarmy.previews.rules';

interface Labelled {
  labels: Record<string, string>;
}

/** The rules saved on `stack`'s services (the first valid copy), or null. */
export function readDashboardPreviews(services: Labelled[], stack: string): PreviewsBlock | null {
  for (const s of services) {
    const raw = s.labels[APP_STACK_LABEL] === stack ? s.labels[PREVIEW_RULES_LABEL] : undefined;
    if (!raw) continue;
    try {
      const parsed = PreviewsSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch {
      // A hand-edited label that isn't JSON: as if nothing were saved.
    }
  }
  return null;
}

/** The label production's services carry while the dashboard holds the rules. */
export function previewRulesLabels(d: Pick<DesiredApp, 'environment' | 'previews'>): Record<string, string> {
  const block = d.environment === PRODUCTION && d.previews?.source === 'dashboard' ? d.previews.dashboard : undefined;
  return block ? { [PREVIEW_RULES_LABEL]: JSON.stringify(block) } : {};
}

/**
 * Does production's swarmy.yaml set `previews:`? A plan from before the
 * rules said where they came from counts as the file's when it shows
 * anything but the defaults.
 */
export function fileSetsPreviews(p: DesiredApp['previews'] | null | undefined): boolean {
  if (!p) return false;
  if (p.source !== undefined) return p.source === 'file';
  return p.enabled || p.branches.length > 0 || p.data !== undefined || p.ttlSeconds !== DEFAULT_PREVIEW_TTL_SECONDS;
}

/**
 * The rules in force: production's last plan when its file sets `previews:`;
 * otherwise what is saved on the stack right now (fresher than the last
 * plan), else the plan's defaults.
 */
export function effectivePreviews(prod: DesiredApp['previews'] | null | undefined, saved: PreviewsBlock | null): DesiredApp['previews'] | null {
  if (fileSetsPreviews(prod)) return prod!;
  if (saved) return desiredPreviews({}, saved);
  return prod ?? null;
}
