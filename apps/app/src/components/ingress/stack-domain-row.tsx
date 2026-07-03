import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDownIcon, Trash2Icon } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
  Badge,
  Button,
  StatusBadge,
  type StatusTone,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { ProtectionChips } from './protection-chips';
import { ProtectionEditor } from './protection-editor';
import type { RouteProtection } from './protection-model';

/** One stack-scoped domain route (mirrors the controller's DomainView). */
export interface StackDomain {
  id: string;
  host: string;
  serviceId: string;
  serviceName: string;
  targetPort: number;
  tls: string;
  pathPrefix: string | null;
  protection: RouteProtection | null;
  canaryPct: number | null;
}

function tlsTone(tls: string): StatusTone {
  if (tls === 'auto') return 'online';
  if (tls === 'custom') return 'progress';
  return 'neutral';
}

/** Flat route row; expanding it opens the inline protection editor. */
export function StackDomainRow({ domain }: { domain: StackDomain }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [expanded, setExpanded] = React.useState(false);

  const remove = useMutation(
    trpc.ingress.removeDomain.mutationOptions({
      onSuccess: () => {
        toast.success(`${domain.host} removed`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const setRoutes = useMutation(
    trpc.ingress.setServiceRoutes.mutationOptions({
      onSuccess: () => {
        toast.success('Protections saved');
        setExpanded(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  // The label carries the service's WHOLE route set — read it fresh, patch this
  // route's protection, write the full array back (host+path identifies the route).
  const saveProtection = async (protection: RouteProtection | null): Promise<void> => {
    const routes = await qc.fetchQuery(
      trpc.ingress.listServiceRoutes.queryOptions({ serviceId: domain.serviceId }),
    );
    const next = routes.map((r) =>
      r.host === domain.host && (r.path ?? null) === domain.pathPrefix
        ? { ...r, protection: protection ?? undefined }
        : r,
    );
    setRoutes.mutate({ serviceId: domain.serviceId, routes: next });
  };

  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={cn(
          'hover:bg-accent/60 flex w-full items-center gap-4 px-6 py-4 text-left transition-colors',
          expanded && 'bg-accent/40',
        )}
      >
        <div className="min-w-0 flex-1">
          <p className="mono-data truncate font-medium">
            {domain.host}
            {domain.pathPrefix ? <span className="text-muted-foreground">{domain.pathPrefix}</span> : null}
          </p>
          <p className="text-muted-foreground mono-label truncate">
            {domain.serviceName} · :{domain.targetPort}
          </p>
        </div>
        <ProtectionChips protection={domain.protection} />
        {domain.canaryPct !== null ? (
          <StatusBadge tone="progress" label={`canary ${Math.round(domain.canaryPct)}%`} className="hidden sm:inline-flex" />
        ) : null}
        <StatusBadge tone={tlsTone(domain.tls)} label={`TLS ${domain.tls}`} className="hidden sm:inline-flex" />
        <ChevronDownIcon className={cn('text-muted-foreground size-4 shrink-0 transition-transform', expanded && 'rotate-180')} />
      </button>
      {expanded ? (
        <ProtectionEditor
          initial={domain.protection}
          saving={setRoutes.isPending}
          onSave={(p) => void saveProtection(p)}
          onCancel={() => setExpanded(false)}
        />
      ) : null}
      {expanded ? (
        <div className="flex justify-end border-t px-6 py-3">
          <RemoveDomainConfirm host={domain.host} pending={remove.isPending} onConfirm={() => remove.mutate({ id: domain.id })} />
        </div>
      ) : null}
    </div>
  );
}

/** Destructive confirm — the one sanctioned modal. */
function RemoveDomainConfirm({ host, pending, onConfirm }: { host: string; pending: boolean; onConfirm: () => void }): React.JSX.Element {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="ghost" size="sm" className="text-status-offline" disabled={pending}>
          <Trash2Icon className="size-4" /> Remove domain
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {host}?</AlertDialogTitle>
          <AlertDialogDescription>
            Traffic to this host stops routing the moment the config re-applies. The route label is
            removed from the service — this can be re-added any time.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Remove</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
