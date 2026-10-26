/**
 * The rendered desired spec as YAML (board 26's "YAML diff"): what swarmy
 * will run for one environment after every default is filled in, the shape a
 * line diff between two releases reads well in. PURE and browser-safe.
 *
 * Signatures (each unit's `sig`, a build source's `key`) are dropped: they
 * are hashes of the rest of the unit, so they change whenever anything else
 * does and would double every hunk. Units keep the order `toDesired` sorts
 * them in (by name), so two renders of the same app line up. No secret value
 * is in a DesiredApp: env holds swarmy.yaml's templates
 * (`${{ secrets.x }}` stays a reference).
 */
import { stringify } from 'yaml';
import type { DesiredApp } from './desired';

const UNITS = ['services', 'resources', 'routes', 'jobs'] as const;

function unsigned<T extends { sig?: string }>(u: T): Omit<T, 'sig'> {
  const { sig: _sig, ...rest } = u;
  return rest;
}

/** The spec as YAML, signatures dropped. `null` in → `null` out (no desired state recorded). */
export function desiredYaml(d: DesiredApp | null | undefined): string | null {
  if (!d) return null;
  const out: Record<string, unknown> = { ...d };
  for (const k of UNITS) out[k] = (d[k] ?? []).map((u) => unsigned(u as { sig?: string }));
  out.services = (d.services ?? []).map((s) => {
    const { sig: _sig, ...rest } = s;
    if (s.source.kind !== 'build') return rest;
    const { key: _key, ...build } = s.source;
    // Re-assigning `source` keeps its place in the key order.
    return { ...rest, source: build };
  });
  return stringify(JSON.parse(JSON.stringify(out)), { lineWidth: 0, aliasDuplicateObjects: false });
}
