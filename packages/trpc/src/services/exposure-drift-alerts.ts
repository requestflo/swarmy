/**
 * Declared-vs-observed exposure drift → alert events (the exposure-audit
 * worker's step). The verdicts are the Exposure page's own — the same
 * `auditExposure` classifier and `driftViolations` messages — so the alert
 * and the Safety page can never disagree. Pure planning; the worker fires.
 *
 * Level signal, ruleless like the other exposure alerts: one event per
 * service (`<stack>/<service>`), refreshed while it drifts, resolved once the
 * service conforms to its declared `swarmy.expose` mode again (or loses it).
 */
import type { ExposureIntentRowView } from '@swarmy/core';
import type { OrgContext } from '../context';
import type { FireEventInput } from './alerts-fire';
import { auditExposure, driftViolations, orgIngressDriver } from './exposure.service';

export const EXPOSURE_DRIFT_SIGNAL = 'exposure-drift';

export interface DriftAlertPlan {
  /** Events to raise (or refresh) this tick. */
  fire: FireEventInput[];
  /** Events to close: services that drifted last tick and conform now. */
  resolve: FireEventInput[];
  /** Resources firing after this tick — hand back as `previous` next time. */
  firing: Set<string>;
}

/** Plan this tick's drift alerts against the resources that fired last tick. */
export function planDriftAlerts(
  rows: readonly ExposureIntentRowView[],
  previous: ReadonlySet<string>,
): DriftAlertPlan {
  const fire: FireEventInput[] = [];
  const firing = new Set<string>();
  for (const v of driftViolations([...rows])) {
    const resource = `${v.stack}/${v.serviceName}`;
    if (firing.has(resource)) continue;
    firing.add(resource);
    fire.push({
      signal: EXPOSURE_DRIFT_SIGNAL,
      severity: v.severity === 'block' ? 'critical' : 'warning',
      resource,
      message: `${v.message} ${v.fixHint}`,
    });
  }
  const resolve: FireEventInput[] = [...previous]
    .filter((r) => !firing.has(r))
    .sort()
    .map((resource) => ({
      signal: EXPOSURE_DRIFT_SIGNAL,
      severity: 'info',
      resource,
      message: `${resource} matches its declared exposure again`,
      status: 'resolved',
    }));
  return { fire, resolve, firing };
}

/** The Exposure page's intent rows for one org (Docker truth + the org driver). */
export async function exposureIntentRows(ctx: OrgContext): Promise<ExposureIntentRowView[]> {
  return auditExposure(ctx, await orgIngressDriver(ctx));
}
