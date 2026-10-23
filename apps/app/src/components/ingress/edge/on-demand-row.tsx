import * as React from 'react';
import { Button, Input, Label, Switch } from '@swarmy/ui';
import { Tech } from '@/components/calm';

/**
 * On-demand certificates for customer domains (`ingress.setOnDemandTls`).
 * Its state is read off the rendered Caddyfile (`on_demand_tls { ask … }`),
 * the one place it is exposed. Turning it on needs the ask address: the
 * controller's `/ingress/ask`, which answers 200 only for a routed host.
 */
export function OnDemandRow({
  on,
  ask,
  admin,
  pending,
  onSet,
}: {
  on: boolean;
  ask: string | null;
  admin: boolean | undefined;
  pending: boolean;
  onSet: (v: { enabled: boolean; askUrl?: string }) => void;
}): React.JSX.Element {
  const [asking, setAsking] = React.useState(false);
  const [url, setUrl] = React.useState(() => ask ?? (typeof window === 'undefined' ? '' : `${window.location.origin}/ingress/ask`));
  const id = React.useId();
  const flip = (v: boolean): void => {
    if (!v) return onSet({ enabled: false });
    if (ask) return onSet({ enabled: true, askUrl: ask });
    setAsking(true);
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start gap-3">
        <Switch
          id={id}
          checked={on}
          onCheckedChange={flip}
          disabled={admin === false || pending}
          aria-label="On-demand certificates for customer domains"
          className="mt-0.5 shrink-0"
        />
        <label htmlFor={id} className="flex flex-col gap-0.5">
          <span className="text-[13.5px] font-semibold">On-demand certificates for customer domains</span>
          <span className="text-muted-foreground text-[12.5px]">Issue at the first visit, only for hosts you&apos;ve added.</span>
        </label>
      </div>
      {asking && !on ? (
        <form
          className="flex flex-col gap-1.5 pl-12"
          onSubmit={(e) => {
            e.preventDefault();
            onSet({ enabled: true, askUrl: url.trim() });
            setAsking(false);
          }}
        >
          <Label htmlFor={`${id}-ask`} className="text-[12.5px]">
            Where the edge asks before it issues
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input id={`${id}-ask`} value={url} onChange={(e) => setUrl(e.target.value)} className="min-w-[220px] flex-1 font-mono text-[12.5px]" />
            <Button type="submit" variant="outline" disabled={pending || !/^https?:\/\/\S+$/.test(url.trim())}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      <Tech className="block pl-12">
        {on ? `on_demand_tls · ask ${ask ?? '(none)'}` : 'on_demand_tls off'} · GET /ingress/ask answers 200 only for a routed host, deny by default
      </Tech>
    </div>
  );
}
