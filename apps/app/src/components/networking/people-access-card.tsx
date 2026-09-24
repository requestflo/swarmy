import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardContent, CardDescription, CardHeader, CardTitle, StatusBadge, Switch, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

const EXPIRY = [1, 8, 12, 24] as const;

/**
 * Networking → Mesh → People access (plan §3.4): on/off (off by default), how
 * long a laptop stays signed in, the default-deny statement, who's online, and
 * — one level down — the NetBird rules swarmy generates (read-only).
 */
export function PeopleAccessCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const card = useQuery({ ...trpc.mesh.people.card.queryOptions(), refetchInterval: 15_000 });
  const [showRules, setShowRules] = React.useState(false);
  const set = useMutation(
    trpc.mesh.people.setSettings.mutationOptions({
      onSuccess: () => {
        toast.success('People access updated');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const d = card.data;
  if (!d) return <div className="shimmer-line h-32 rounded-2xl" />;
  if (!d.managed) {
    return (
      <Card className="card-pop border-0">
        <CardHeader>
          <CardTitle className="text-base">People access</CardTitle>
          <CardDescription>Needs the mesh control plane that runs in swarmy (install with --mesh swarmy).</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  const on = d.settings.enabled;
  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-base">People access</CardTitle>
            <CardDescription>
              Let people reach private services — databases, admin pages — from their laptop. Each app's own rules decide who gets
              what; nothing else is reachable, not even the servers.
            </CardDescription>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={on} disabled={set.isPending} onCheckedChange={(v) => set.mutate({ enabled: v })} />
            {on ? 'On' : 'Off'}
          </label>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          <StatusBadge tone={d.online > 0 ? 'online' : 'neutral'} label={`${d.online} online · ${d.devices} device${d.devices === 1 ? '' : 's'}`} />
          <span className="text-muted-foreground">{d.identity}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">A laptop signs in again after</span>
          {EXPIRY.map((h) => (
            <button
              key={h}
              type="button"
              className={
                'h-7 rounded-lg border px-2.5 text-xs font-semibold ' +
                (d.settings.loginExpiryHours === h ? 'bg-accent border-transparent' : 'text-muted-foreground')
              }
              onClick={() => set.mutate({ loginExpiryHours: h })}
            >
              {h} h
            </button>
          ))}
          <span className="text-muted-foreground">. Leaving the organisation cuts access within 30 seconds.</span>
        </div>
        <p className="text-muted-foreground">
          Default deny: a person reaches only the services and ports of the apps they may connect to, by rule (Access → Policies,
          action <span className="mono-data">mesh.connect</span>) or by a personal grant on the app.
        </p>
        {d.plan && (
          <div>
            <button type="button" className="text-xs underline underline-offset-2" onClick={() => setShowRules((v) => !v)}>
              {showRules ? 'Hide' : 'Show'} the mesh rules swarmy writes
            </button>
            {showRules && (
              <pre className="bg-muted mono-data mt-2 max-h-80 overflow-auto rounded-xl p-3 text-xs">
                {JSON.stringify(d.plan, null, 2)}
              </pre>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
