import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@swarmy/ui';
import { Section, Tech } from '@/components/calm';
import { CardSkeleton } from '@/components/states';
import { useTRPC } from '@/integrations/trpc';
import type { StackDomain } from '@/components/ingress/stack-domain-row';
import { routeDriverPlan, type RouteDriverValue } from './route-driver-model';
import { useRoutePatch } from './use-route-patch';

/**
 * Which front door serves this one address (Controls): the org's own, its
 * Cloudflare Tunnel, or left to you — only what the org's edge can run. It
 * is the route's `driver`, saved on the service's swarmy.ingress.routes
 * label. Automatic addresses always ride the org's front door.
 */
export function RouteDriverPicker({ domain: d }: { domain: StackDomain }): React.JSX.Element | null {
  const trpc = useTRPC();
  const config = useQuery(trpc.ingress.getConfig.queryOptions());
  const { patch, saving } = useRoutePatch(d);
  const [shown, setShown] = React.useState<{ v: RouteDriverValue } | null>(null);
  if (d.auto) return null;
  if (!config.data) return <CardSkeleton lines={2} />;
  const org = config.data.driver;
  const plan = routeDriverPlan({ orgDriver: org, tunnelConfigured: config.data.tunnelConfigured, expose: d.expose, routeDriver: d.ingressDriver });
  if (!plan.locked && plan.choices.length < 2) return null;
  const current = shown ? shown.v : plan.current;
  const picked = plan.choices.find((c) => c.value === current);

  const pick = (v: RouteDriverValue, label: string): void => {
    if (v === current) return;
    setShown({ v });
    void patch({ driver: v ?? undefined }, `${d.host}: ${label.toLowerCase()}`).finally(() => setShown(null));
  };

  return (
    <Section title="Which front door serves it" hint="this address only">
      {plan.locked ? (
        <p className="text-muted-foreground text-[13px] leading-snug">{plan.locked}</p>
      ) : (
        <div className="flex flex-col gap-2">
          <div role="radiogroup" aria-label={`Which front door serves ${d.host}`} className="border-border bg-background inline-flex w-fit max-w-full flex-wrap gap-0.5 rounded-[10px] border p-0.5">
            {plan.choices.map((c) => (
              <button
                key={c.value ?? 'org'}
                type="button"
                role="radio"
                aria-checked={current === c.value}
                disabled={saving || (!c.available && current !== c.value)}
                onClick={() => pick(c.value, c.label)}
                className={cn(
                  'h-8 rounded-[8px] px-3 text-[13px] font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-60 pointer-coarse:min-h-11',
                  current === c.value ? 'bg-surface-2 text-foreground dark:bg-accent' : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {c.label}
              </button>
            ))}
          </div>
          {picked ? <p className={cn('text-[13px] leading-snug', picked.available ? 'text-muted-foreground' : 'text-tone-warn')}>{picked.say}</p> : null}
        </div>
      )}
      <Tech>
        route driver on {d.serviceName}’s swarmy.ingress.routes: {d.ingressDriver ?? `unset, the org’s ${org}`}
        {d.expose ? ` · swarmy.expose: ${d.expose} (wins)` : ''}
      </Tech>
    </Section>
  );
}
