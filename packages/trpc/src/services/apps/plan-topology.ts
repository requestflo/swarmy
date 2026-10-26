/**
 * The app a plan leaves behind, as the plan drawer's Graph draws it (board
 * 26): every address with the service it reaches, every service with the
 * data it uses, every data store — read off the plan's own desired state, so
 * the boxes a plan doesn't touch, and the lines between them, are drawn too.
 * Names and wiring only; PURE.
 */
import type { DesiredApp } from '@swarmy/app-config';

export interface PlanTopology {
  routes: Array<{ host: string; path: string; service: string }>;
  /** `uses`: the resources this service's env binds (its `dependsOn`, services left out). */
  services: Array<{ name: string; uses: string[] }>;
  resources: Array<{ name: string; type: string }>;
}

export function planTopology(desiredJson: unknown): PlanTopology | null {
  const d = desiredJson as Partial<DesiredApp> | null;
  if (!d || !Array.isArray(d.services)) return null;
  const resources = (d.resources ?? []).map((r) => ({ name: r.name, type: r.type }));
  const names = new Set(resources.map((r) => r.name));
  return {
    routes: (d.routes ?? []).map((r) => ({ host: r.host, path: r.path, service: r.service })),
    services: d.services.map((s) => ({ name: s.name, uses: (s.dependsOn ?? []).filter((x) => names.has(x)) })),
    resources,
  };
}
