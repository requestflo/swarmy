import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LockKeyholeIcon } from 'lucide-react';
import { Switch, cn, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { IDENTITY_HEADERS, type AppAccessRoute } from './types';

interface RequireLoginCardProps {
  stack: string;
  routes: AppAccessRoute[];
}

/** The "Require login" toggle — the whole app, or route by route. */
export function RequireLoginCard({ stack, routes }: RequireLoginCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const set = useMutation(
    trpc.appAccess.setRequireLogin.mutationOptions({
      onSuccess: (_d, v) => {
        toast.success(v.on ? 'Login required. Only people you allow can open it.' : 'Login removed. The app is public again.');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const on = routes.filter((r) => r.requireLogin).length;
  const all = on === routes.length;

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="say text-xl">
            Require <em>login</em>
          </h2>
          <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
            swarmy signs people in at the edge with your organisation's login, before any request reaches the app. The app
            needs no auth code.
          </p>
        </div>
        <label className="flex items-center gap-3 font-semibold">
          <span className="mono-label text-muted-foreground">{all ? 'On' : on > 0 ? 'Partly on' : 'Off'}</span>
          <Switch
            checked={all}
            disabled={set.isPending}
            onCheckedChange={(v) => set.mutate({ stack, on: v })}
            aria-label="Require login for the whole app"
          />
        </label>
      </div>

      <div className="calm-card shadow-none divide-border divide-y overflow-hidden">
        {routes.map((r) => (
          <div key={r.id} className={cn('flex flex-wrap items-center justify-between gap-3 px-5 py-3', r.requireLogin && 'bg-accent/40')}>
            <div className="flex min-w-0 items-center gap-3">
              <LockKeyholeIcon className={cn('size-4 shrink-0', r.requireLogin ? 'text-primary' : 'text-muted-foreground')} />
              <span className="mono-data truncate">
                {r.host}
                {r.path !== '/' ? r.path : ''}
              </span>
              <span className="text-muted-foreground mono-label hidden sm:inline">{r.serviceName}</span>
            </div>
            <Switch
              checked={r.requireLogin}
              disabled={set.isPending}
              onCheckedChange={(v) => set.mutate({ stack, on: v, routeIds: [r.id] })}
              aria-label={`Require login on ${r.host}${r.path}`}
            />
          </div>
        ))}
      </div>

      {on > 0 ? (
        <p className="text-muted-foreground text-sm">
          The app receives <span className="mono-data">{IDENTITY_HEADERS.join(', ')}</span>. Any client-sent copies are
          stripped first. Verify the JWT with <span className="mono-data">getSession(req)</span> from{' '}
          <span className="mono-data">@swarmy/app-auth</span>, or against{' '}
          <span className="mono-data">/.well-known/swarmy-jwks.json</span>.
        </p>
      ) : null}
    </section>
  );
}
