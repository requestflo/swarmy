import * as React from 'react';
import { Switch } from '@swarmy/ui';
import { RumSection } from './rum-ui';
import { useSetRumRoute } from './use-rum';
import type { RumRoute } from './rum-shared';

interface RoutesCardProps {
  stack: string;
  routes: RumRoute[];
  disabled: boolean;
}

/** Per-domain toggles: a route follows the app unless it has its own setting. */
export function RoutesCard({ stack, routes, disabled }: RoutesCardProps): React.JSX.Element {
  const setRoute = useSetRumRoute(stack);
  const flip = (r: RumRoute, override: 'on' | 'off' | null): void =>
    setRoute.mutate({ stack, service: r.service, host: r.host, path: r.path, override });

  return (
    <RumSection title="Routes" badge={<span className="text-muted-foreground text-xs">each domain of this app</span>}>
      {routes.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          This app has no domains yet. Add one on the Network tab — the tag is injected where visitors arrive.
        </p>
      ) : (
        <ul className="divide-border divide-y">
          {routes.map((r) => (
            <li key={`${r.service}|${r.host}|${r.path}`} className="flex flex-wrap items-center gap-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono font-semibold">
                {r.host}
                {r.path === '/' ? '' : r.path}
              </span>
              <span className="text-muted-foreground text-xs">
                {r.service} · {r.override ? `own setting (${r.override})` : 'follows the app'}
              </span>
              {r.override ? (
                <button
                  type="button"
                  disabled={disabled || setRoute.isPending}
                  onClick={() => flip(r, null)}
                  className="text-muted-foreground hover:text-foreground text-xs underline underline-offset-2"
                >
                  reset
                </button>
              ) : null}
              <Switch
                checked={r.injected}
                disabled={disabled || setRoute.isPending}
                onCheckedChange={(on) => flip(r, on ? 'on' : 'off')}
                aria-label={`Record ${r.host}${r.path}`}
              />
            </li>
          ))}
        </ul>
      )}
    </RumSection>
  );
}
