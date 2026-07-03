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
  Collapsible,
  CollapsibleContent,
  CopyButton,
  Label,
  StatusBadge,
  cn,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { enabledTone, type SsoProviderEntry } from './access-shared';
import { SsoProviderFields } from './sso-provider-fields';

interface SsoProviderRowProps {
  provider: SsoProviderEntry;
  expanded: boolean;
  onToggle: () => void;
}

/** One SSO provider row; Edit expands the upsert form + callback URL + delete inline. */
export function SsoProviderRow({ provider: p, expanded, onToggle }: SsoProviderRowProps): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [domain, setDomain] = React.useState(p.domain ?? '');
  const [issuer, setIssuer] = React.useState(p.issuer ?? '');
  const [discoveryUrl, setDiscoveryUrl] = React.useState((p.metadata?.discoveryUrl as string) ?? '');
  const [clientId, setClientId] = React.useState(p.clientId ?? '');
  const [clientSecret, setClientSecret] = React.useState('');

  const upsert = useMutation(
    trpc.sso.upsert.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider saved');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const del = useMutation(
    trpc.sso.delete.mutationOptions({
      onSuccess: () => {
        toast.success('SSO provider deleted');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <div className={cn(expanded && 'bg-accent/40 shadow-[inset_3px_0_0_var(--primary)]')}>
      <button
        type="button"
        onClick={onToggle}
        className="hover:bg-accent/60 grid w-full grid-cols-[1.5fr_auto] items-center gap-x-4 px-6 py-4 text-left transition-colors sm:grid-cols-[2fr_1fr_1.5fr_1fr_auto]"
      >
        <div className="min-w-0">
          <p className="truncate font-medium">{p.providerId}</p>
          <p className="text-muted-foreground mono-label truncate sm:hidden">
            {p.protocol.toUpperCase()} · {p.domain ?? 'no domain'}
          </p>
        </div>
        <Badge variant="muted" className="hidden sm:inline-flex">
          {p.protocol.toUpperCase()}
        </Badge>
        <span className="mono-data hidden truncate sm:block">{p.domain ?? '—'}</span>
        <span className="hidden sm:block">
          <StatusBadge tone={enabledTone(p.enabled)} label={p.enabled ? 'enabled' : 'disabled'} />
        </span>
        <ChevronDownIcon className={cn('size-4 justify-self-end transition-transform', expanded && 'rotate-180')} />
      </button>
      <Collapsible open={expanded}>
        <CollapsibleContent>
          <div className="space-y-4 px-6 pb-6">
            <div className="grid gap-3 sm:grid-cols-2">
              <SsoProviderFields
                provider={p}
                discoveryUrl={discoveryUrl}
                onDiscoveryUrlChange={setDiscoveryUrl}
                issuer={issuer}
                onIssuerChange={setIssuer}
                domain={domain}
                onDomainChange={setDomain}
                clientId={clientId}
                onClientIdChange={setClientId}
                clientSecret={clientSecret}
                onClientSecretChange={setClientSecret}
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">Callback URL (paste into IdP)</Label>
              <div className="flex items-center gap-2">
                <code className="bg-muted mono-data flex-1 overflow-x-auto rounded-lg px-3 py-2 text-xs">
                  {p.callbackUrl}
                </code>
                <CopyButton value={p.callbackUrl} label="Copy" />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <Button
                size="sm"
                disabled={upsert.isPending}
                onClick={() =>
                  upsert.mutate({
                    id: p.id,
                    providerId: p.providerId,
                    protocol: p.protocol,
                    domain: domain || null,
                    issuer: issuer || null,
                    clientId: clientId || null,
                    clientSecret: clientSecret || undefined,
                    metadata: discoveryUrl ? { discoveryUrl } : {},
                  })
                }
              >
                {upsert.isPending ? 'Saving…' : 'Save changes'}
              </Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" className="text-status-offline" disabled={del.isPending}>
                    <Trash2Icon className="size-4" /> Delete
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Delete SSO provider "{p.providerId}"?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Anyone signing in through this provider will be unable to. There is no undo.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Keep it</AlertDialogCancel>
                    <AlertDialogAction onClick={() => del.mutate({ id: p.id })}>Delete provider</AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
