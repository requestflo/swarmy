import * as React from 'react';
import { geoPath, type GeoProjection } from 'd3-geo';
import { feature } from 'topojson-client';
// Vite gives us the bundled asset URL (avoids inlining a ~100 KB JSON literal type
// into the typecheck); we fetch + parse it once at runtime.
import worldUrl from 'world-atlas/countries-110m.json?url';

/**
 * Natural-Earth country outlines (`world-atlas` 110m) projected to SVG paths
 * for `projection`. Null while loading; [] when the asset can't be fetched
 * (callers still draw their markers). Shared by the region globe and the
 * domain check's resolver map.
 */
export function useWorldCountries(projection: GeoProjection): string[] | null {
  const [countries, setCountries] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    const path = geoPath(projection);
    (async () => {
      try {
        const res = await fetch(worldUrl);
        const topo = (await res.json()) as Parameters<typeof feature>[0];
        const obj = topo.objects.countries;
        if (!obj) {
          if (!cancelled) setCountries([]);
          return;
        }
        const fc = feature(topo, obj);
        const feats = 'features' in fc ? fc.features : [fc];
        const ds = feats.map((f) => path(f) ?? '').filter(Boolean);
        if (!cancelled) setCountries(ds);
      } catch {
        if (!cancelled) setCountries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projection]);
  return countries;
}
