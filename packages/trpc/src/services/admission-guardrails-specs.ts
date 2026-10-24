/**
 * Guardrails spec facts: the slice of each incoming deploy spec the guardrail
 * rules inspect, coerced from the admission intent's unknown specs. Pure.
 */

/** The slice of a deploy spec this evaluator inspects. */
export interface GuardrailSpecFacts {
  name: string;
  image: string;
  labels: Record<string, string>;
  /** Published ports using host mode (bypass the routing mesh, bind the node). */
  hostPorts: number[];
  hasHealthcheck: boolean;
  hasMemoryLimit: boolean;
  privileged: boolean;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/** Coerce unknown intent specs into the facts this evaluator needs. */
export function specFacts(specs: unknown[]): GuardrailSpecFacts[] {
  const out: GuardrailSpecFacts[] = [];
  for (const raw of specs) {
    if (typeof raw !== 'object' || raw === null) continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name) continue;
    const labels =
      typeof o.labels === 'object' && o.labels !== null
        ? (o.labels as Record<string, string>)
        : {};

    const hostPorts: number[] = [];
    if (Array.isArray(o.ports)) {
      for (const p of o.ports) {
        if (typeof p !== 'object' || p === null) continue;
        const port = p as Record<string, unknown>;
        const published = num(port.published);
        if (port.mode === 'host' && published !== undefined && published > 0) {
          hostPorts.push(published);
        }
      }
    }

    const hc = (typeof o.healthcheck === 'object' && o.healthcheck !== null
      ? o.healthcheck
      : null) as { disable?: unknown; test?: unknown } | null;
    const hcTest = Array.isArray(hc?.test) ? (hc.test as unknown[]) : null;
    const hasHealthcheck =
      hc !== null && hc.disable !== true && (hcTest === null || hcTest[0] !== 'NONE');

    const resources = (typeof o.resources === 'object' && o.resources !== null
      ? o.resources
      : {}) as { limits?: { memoryBytes?: unknown } };
    const hasMemoryLimit = (num(resources.limits?.memoryBytes) ?? 0) > 0;

    const caps = [
      ...(Array.isArray(o.capAdd) ? o.capAdd : []),
      ...(Array.isArray(o.cap_add) ? o.cap_add : []),
    ];
    const privileged =
      o.privileged === true || caps.includes('ALL') || caps.includes('SYS_ADMIN');

    out.push({
      name: o.name,
      image: typeof o.image === 'string' ? o.image : '',
      labels,
      hostPorts,
      hasHealthcheck,
      hasMemoryLimit,
      privileged,
    });
  }
  return out;
}

/** True when an image ref would float on `:latest` (explicit, or no tag at all). */
export function isLatestImage(image: string): boolean {
  if (!image) return false;
  if (image.includes('@')) return false; // digest-pinned = immutable
  const lastSegment = image.slice(image.lastIndexOf('/') + 1);
  const colon = lastSegment.lastIndexOf(':');
  if (colon < 0) return true; // no tag → Docker pulls :latest
  return lastSegment.slice(colon + 1) === 'latest';
}
