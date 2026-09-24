import {
  APP_SECRET_ORG_LABEL,
  appSecretsToPrune,
  decodeAppSecrets,
  type GcServiceView,
} from '@swarmy/core';
import type { SecretListResult, SwarmServiceInfo } from '@swarmy/core/protocol';
import { hub, store } from '../gateway';

/**
 * App-secret GC — the "remove the old version after the update converges"
 * half of secret-variable rotation. Rotation creates `<service>_<KEY>_v<N+1>`
 * and rolling-updates the service onto it; this loop removes superseded
 * versions (and those of removed variables) once the decision in
 * `appSecretsToPrune` (`@swarmy/core` app-secrets) says it is safe: no service
 * references them, the service is converged (no update or rollback in
 * flight), and its last change is older than the health-gate window + margin.
 *
 * Docker-truth only: `secret.list` labels + the hub's live service snapshot.
 * Never reads a value (Docker can't return one anyway). Docker itself refuses
 * to remove a secret a service still uses, so a race is a no-op.
 */

const INTERVAL_MS = 2 * 60_000;
const DISPATCH_TIMEOUT_MS = 30_000;

function gateWindowSec(labels: Record<string, string>): number | null {
  const raw = labels['swarmy.deploy.safety'];
  if (!raw) return null;
  try {
    const v = Number((JSON.parse(raw) as { windowSec?: unknown }).windowSec);
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

/** PURE — hub service snapshot → the GC's service view. */
export function gcServiceViews(services: readonly SwarmServiceInfo[]): GcServiceView[] {
  return services.map((s) => ({
    name: s.name,
    secrets: s.secrets ?? [],
    converged: !s.updateStatus || ['none', 'completed', 'rollback_completed'].includes(s.updateStatus),
    updatedAt: s.updatedAt,
    gateWindowSec: gateWindowSec(s.labels),
  }));
}

async function sweepOrg(orgId: string): Promise<void> {
  const node = hub.managerNode(orgId);
  if (!node) return;
  const res = await hub.dispatch<SecretListResult>(node, 'secret.list', {}, { timeoutMs: DISPATCH_TIMEOUT_MS });
  const raw = (res.secrets ?? []).filter((s) => s.labels?.[APP_SECRET_ORG_LABEL] === orgId);
  if (raw.length === 0) return;
  const versions = decodeAppSecrets(raw, orgId);
  const { services } = hub.liveInventory(orgId);
  for (const name of appSecretsToPrune(versions, gcServiceViews(services), Date.now())) {
    await hub
      .dispatch(node, 'secret.remove', { name }, { timeoutMs: DISPATCH_TIMEOUT_MS })
      .catch(() => undefined); // in use / already gone — next tick re-decides
  }
}

export function startAppSecretGc(): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    const orgIds = [...new Set(store.nodeOrg.values())];
    void Promise.allSettled(orgIds.map((o) => sweepOrg(o))).finally(() => {
      running = false;
    });
  }, INTERVAL_MS);
  return () => clearInterval(timer);
}
