/**
 * A cloned environment's own addresses (board Environments: each lane's
 * domain). Every service production serves on a domain gets a stable
 * per-environment host in the clone — the same `<service>-<stack>.<base>` an
 * automatic address takes (`autoLabelFor`, the org's address base: its own
 * delegated zone, the cluster zone, the configured base or sslip.io) — as a
 * planned route, so it is in the plan, the ledger and `${{ app.url }}`, and
 * routed by the same label machinery as any domain. Null when no base can be
 * formed yet (no edge IP, or behind a tunnel): the clone plans no route, as
 * before, and the next push picks one up.
 */
import { environmentStack } from '@swarmy/app-config';
import { autoLabelFor } from '@swarmy/ingress';
import type { OrgContext } from '../../context';
import { autoAddressBase } from '../auto-address.service';

/** PURE — the host function for one environment's stack under `base`. */
export function cloneHostFor(stack: string, base: string): (service: string) => string {
  return (service) => `${autoLabelFor(stack, service)}.${base}`;
}

/** `{ hostFor }` for a dashboard clone of `app` named `environment`, or `{}` when there's no base. */
export async function cloneHosts(
  ctx: OrgContext,
  app: string,
  environment: string,
): Promise<{ hostFor?: (service: string) => string }> {
  const base = await autoAddressBase(ctx).catch(() => null);
  return base ? { hostFor: cloneHostFor(environmentStack(app, environment), base) } : {};
}
