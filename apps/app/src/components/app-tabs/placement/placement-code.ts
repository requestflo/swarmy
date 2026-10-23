import { toYaml, withHeader, type CodeTab } from '@/components/calm';
import type { PlacedService } from '../scaling/use-app-placement';
import { shortName } from '../use-stack-services';

/**
 * Placement & volumes as code: each part's live placement rules and mounts
 * as compose, with the picked part's region declarations as the service
 * labels swarmy reads (`swarmy.region.<region>.replicas`).
 */
export function placementCode(stack: string, rows: PlacedService[], picked: string | undefined, declared: Map<string, number> | undefined): CodeTab[] {
  type Svc = { volumes?: string[]; deploy: { mode?: string; replicas?: number; placement?: { constraints: string[] }; labels?: Record<string, string> } };
  const services: Record<string, Svc> = {};
  for (const r of rows) {
    const name = shortName(stack, r.inv.name);
    const constraints = r.detail?.constraints ?? [];
    const volumes = (r.detail?.volumes ?? []).map((v) => `${v.source ? `${v.source}:` : ''}${v.target}${v.readOnly ? ':ro' : ''}`);
    const labels = r.inv.id === picked && declared?.size ? Object.fromEntries([...declared].map(([reg, n]) => [`swarmy.region.${reg}.replicas`, String(n)])) : undefined;
    services[name] = {
      ...(volumes.length ? { volumes } : {}),
      deploy: {
        ...(r.inv.mode === 'global' ? { mode: 'global' } : { replicas: r.inv.replicas.desired }),
        ...(constraints.length ? { placement: { constraints } } : {}),
        ...(labels ? { labels } : {}),
      },
    };
  }
  return [{ label: 'compose', code: withHeader(`${stack} — placement and volumes as swarmy runs them`, toYaml({ services })) }];
}

export const PLACEMENT_NOTE =
  'Read-only: what swarmy runs now. Regions are service labels the region worker turns into one pinned copy-set per region; there is no REST route for them yet, and swarmy.yaml’s regions: is a plain pin, not per-region copies.';
