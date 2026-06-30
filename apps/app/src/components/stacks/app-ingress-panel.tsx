import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GlobeIcon, PlusIcon } from 'lucide-react';
import { Badge, Button, Skeleton, toast } from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { AppIngressRouteRow } from './app-ingress-route-row';

/**
 * One editable ingress route, mirroring the server `Route` on the
 * `swarmy.ingress.routes` service label. `middlewares`/`driver` aren't edited
 * here but are carried through the draft so a save never silently drops them.
 */
export interface RouteDraft {
  host: string;
  port: number;
  tls: 'auto' | 'off' | 'manual';
  path?: string;
  stripPrefix?: boolean;
  middlewares?: string[];
  driver?: string;
}

interface AppIngressPanelProps {
  serviceId: string;
  serviceName: string;
}

/** Clone a server route into an editable draft (so edits never touch the query cache). */
function toDraft(r: RouteDraft): RouteDraft {
  return { ...r, tls: r.tls ?? 'auto' };
}

/**
 * Per-service ingress routes on the canvas service sheet: list / add / remove the
 * routes carried on this service's `swarmy.ingress.routes` label and write them
 * back in one shot via `ingress.setServiceRoutes`. Gated on org ingress being on.
 */
export function AppIngressPanel({ serviceId, serviceName }: AppIngressPanelProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const config = useQuery(trpc.ingress.getConfig.queryOptions());
  const routesQ = useQuery({
    ...trpc.ingress.listServiceRoutes.queryOptions({ serviceId }),
    enabled: !!serviceId,
  });
  const portsQ = useQuery({
    ...trpc.ingress.detectPorts.queryOptions({ serviceId }),
    enabled: !!serviceId,
  });

  // `?? []` plus an Array guard: in demo mode an un-resolved path falls back to a
  // non-array shape, so never assume the query data is iterable.
  const serverRoutes = React.useMemo(
    () => (Array.isArray(routesQ.data) ? routesQ.data : []),
    [routesQ.data],
  );

  // Draft is seeded from the server once, then owned locally until a save resets it.
  const [draft, setDraft] = React.useState<RouteDraft[] | null>(null);
  React.useEffect(() => {
    if (routesQ.data && draft === null) setDraft(serverRoutes.map(toDraft));
  }, [routesQ.data, serverRoutes, draft]);

  const save = useMutation(
    trpc.ingress.setServiceRoutes.mutationOptions({
      onSuccess: () => {
        toast.success('Routes updated');
        setDraft(null); // re-seed from the refetched truth
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const detected = React.useMemo(() => {
    const set = new Set<number>();
    for (const p of Array.isArray(portsQ.data) ? portsQ.data : []) set.add(p.port);
    return [...set].sort((a, b) => a - b);
  }, [portsQ.data]);
  const rows = draft ?? [];
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(serverRoutes.map(toDraft));
  const enabled = !!config.data?.enabled;

  const patchRow = (i: number, patch: Partial<RouteDraft>): void =>
    setDraft((cur) => (cur ?? []).map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const removeRow = (i: number): void => setDraft((cur) => (cur ?? []).filter((_, idx) => idx !== i));
  const addRow = (): void =>
    setDraft((cur) => [...(cur ?? []), { host: '', port: detected[0] ?? 80, tls: 'auto' }]);

  const validRoutes = rows.filter((r) => r.host.trim().length > 0 && r.port > 0);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-sm font-semibold">
          <GlobeIcon className="text-status-progress size-4" /> Ingress routes
          {rows.length > 0 && <Badge variant="muted">{rows.length}</Badge>}
        </p>
        {enabled && (
          <Button variant="ghost" size="sm" onClick={addRow}>
            <PlusIcon className="size-4" /> Add
          </Button>
        )}
      </div>

      {config.isLoading || routesQ.isLoading ? (
        <Skeleton className="h-20 w-full rounded-xl" />
      ) : !enabled ? (
        <p className="text-muted-foreground text-xs">
          Ingress is paused. Turn on a driver in{' '}
          <Link to="/ingress" className="text-primary font-medium underline-offset-2 hover:underline">
            Ingress settings
          </Link>{' '}
          to route <span className="mono-data">{serviceName}</span> to a domain.
        </p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          No routes yet — add one to map a domain to this service.
        </p>
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <AppIngressRouteRow
              key={i}
              route={r}
              detectedPorts={detected}
              disabled={save.isPending}
              onChange={(patch) => patchRow(i, patch)}
              onRemove={() => removeRow(i)}
            />
          ))}
        </div>
      )}

      {enabled && dirty && (
        <Button
          className="w-full"
          disabled={save.isPending || validRoutes.length !== rows.length}
          onClick={() => save.mutate({ serviceId, routes: validRoutes })}
        >
          Save routes
        </Button>
      )}
    </section>
  );
}
