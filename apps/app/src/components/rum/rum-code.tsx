import * as React from 'react';
import { CodeView } from '@/components/calm';
import type { RumRoute, RumSettings } from './rum-shared';

/** The `swarmy.rum` label exactly as swarmy serialises it (keys sorted, JSON). */
export function rumLabel(s: RumSettings): string {
  const sorted: Record<string, unknown> = {};
  for (const k of Object.keys(s).sort()) sorted[k] = (s as Record<string, unknown>)[k];
  return JSON.stringify(sorted);
}

/**
 * Code depth for analytics / replays / their settings: the label the edge
 * reads (no redeploy), and each route's own override. There is no CLI or REST
 * for RUM settings yet, so this is read-only.
 */
export function RumCode({ stack, settings, routes }: { stack: string; settings: RumSettings; routes: RumRoute[] }): React.JSX.Element {
  const label = [`# on every ${stack} service; the edge (swarmy_rum Caddy module) reads it on the next page view`, `swarmy.rum=${rumLabel(settings)}`].join('\n');
  const perRoute = routes.length
    ? routes.map((r) => `${r.host}${r.path && r.path !== '/' ? r.path : ''}  rum: ${r.override ?? 'follows the app'}${r.injected ? '' : '  (not injected)'}`).join('\n')
    : '# no routes: add a domain first';
  return (
    <CodeView
      source="readonly"
      note="A dashboard setting stored as a Docker label. The edge applies it at once, without a redeploy."
      tabs={[
        { label: 'label', code: label },
        { label: 'routes', code: `# swarmy.ingress.routes: a route's own rum on|off wins over the app\n${perRoute}` },
      ]}
    />
  );
}
