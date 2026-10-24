import type { DemoStore, DomainResolvers } from '../types';

/**
 * The edge's country database (`ingress.edgeGeoip` / `ingress.setEdgeGeoip`).
 * Mirrors `EdgeGeoipView` in packages/trpc/src/services/edge-geoip.service.ts:
 * the demo edge runs swarmy's Caddy build, so the bundled DB-IP Country Lite
 * is in use until the visitor picks a file or turns it off.
 */

type Mode = 'bundled' | 'file' | 'off';

interface EdgeGeoipState {
  mode: Mode;
  path: string | null;
}

const BUNDLED = '/usr/share/swarmy/geoip/dbip-country-lite.mmdb';

function state(store: DemoStore): EdgeGeoipState {
  const cur = store.extra.edgeGeoip as EdgeGeoipState | undefined;
  if (cur) return cur;
  const fresh: EdgeGeoipState = { mode: 'bundled', path: null };
  store.extra.edgeGeoip = fresh;
  return fresh;
}

function view(s: EdgeGeoipState) {
  const effectivePath = s.mode === 'bundled' ? BUNDLED : s.mode === 'file' ? s.path : null;
  return {
    mode: s.mode,
    path: s.mode === 'file' ? s.path : null,
    effectivePath,
    source: s.mode === 'off' ? 'off' : effectivePath ? s.mode : 'unavailable',
    bundledPath: BUNDLED,
    attribution: 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0',
  };
}

export const edgeGeoip: DomainResolvers = {
  handlers: {
    'ingress.edgeGeoip': (_i, store) => view(state(store)),
    'ingress.setEdgeGeoip': (i, store) => {
      const input = i as { mode: Mode; path?: string };
      const s = state(store);
      s.mode = input.mode;
      s.path = input.mode === 'file' ? (input.path ?? null) : null;
      return view(s);
    },
  },
};
