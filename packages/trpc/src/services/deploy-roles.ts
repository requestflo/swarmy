/**
 * PURE: which service of a traced deploy is "the app" (its pull + start are
 * the tracker's steps 1 and 3) and which are companions (folded into step 2,
 * "Create its data"). Same rule the dashboard's tracker uses: the routed
 * service, else one that publishes a port, else the first.
 */
import type { DeployWatch, ServiceSpec } from '@swarmy/core/protocol';
import { INGRESS_ROUTES_LABEL } from './ingress-routes';

type Spec = Pick<ServiceSpec, 'name' | 'labels' | 'ports'>;

export function mainServiceOf(specs: readonly Spec[], preferred?: string): string | null {
  const byName = preferred ? specs.find((s) => s.name === preferred || s.name.endsWith(`_${preferred}`)) : undefined;
  const routed = specs.find((s) => {
    const raw = s.labels?.[INGRESS_ROUTES_LABEL];
    return !!raw && raw !== '[]';
  });
  return (byName ?? routed ?? specs.find((s) => (s.ports?.length ?? 0) > 0) ?? specs[0])?.name ?? null;
}

/** The `watch` each spec's `deployService` carries. */
export function deployWatchFor(
  trace: { id: string; stack: string },
  spec: Spec,
  main: string | null,
): DeployWatch {
  return { deployId: trace.id, stack: trace.stack, role: spec.name === main ? 'main' : 'data' };
}
