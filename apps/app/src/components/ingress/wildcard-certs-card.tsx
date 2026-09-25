import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  StatusBadge,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { CardSkeleton } from '@/components/states';

const PROVIDER_LABEL: Record<string, string> = { swarmy: 'swarmy DNS', cloudflare: 'Cloudflare token' };

/**
 * Wildcard certificates (ACME DNS-01). Primary path: the zone is served by
 * swarmy's own nameservers — nothing to configure. Optional secondary: a
 * provider API token for a wildcard in a zone swarmy does not serve.
 */
export function WildcardCertsCard(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const view = useQuery(trpc.ingress.dnsChallenge.queryOptions());
  const [token, setToken] = React.useState('');
  const setProvider = useMutation(
    trpc.ingress.setDnsProvider.mutationOptions({
      onSuccess: (v) => {
        setToken('');
        toast.success(v.byo ? 'Cloudflare token saved as a Docker secret' : 'DNS provider token removed');
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  if (view.isPending) return <CardSkeleton className="mt-6" />;
  const v = view.data;

  return (
    <Card className="calm-card mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">Wildcard certificates</CardTitle>
        <CardDescription>
          <span className="mono-data">*.example.com</span> needs ACME DNS-01. When the zone&rsquo;s NS records point at
          swarmy, swarmy&rsquo;s own nameservers answer the challenge — no DNS provider, no API token.
          {v && v.swarmyZones.length > 0 ? (
            <>
              {' '}Served by swarmy: <span className="mono-data">{v.swarmyZones.join(', ')}</span>.
            </>
          ) : (
            <> Add a zone under Geo-DNS below to get started.</>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {v && v.wildcards.length > 0 ? (
          <div className="border-border divide-border divide-y rounded-xl border">
            {v.wildcards.map((w) => (
              <div key={w.host} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="mono-data min-w-0 flex-1 truncate">{w.host}</span>
                <StatusBadge
                  tone={w.provider ? 'online' : 'warning'}
                  label={w.provider ? `DNS-01 via ${PROVIDER_LABEL[w.provider] ?? w.provider}` : 'No DNS-01 path yet'}
                />
              </div>
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">No wildcard domains yet — add one like any other domain.</p>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="byo-dns-token" className="mono-label">
            Optional · Cloudflare API token (zones swarmy doesn&rsquo;t serve)
          </Label>
          <div className="flex flex-wrap gap-2">
            <Input
              id="byo-dns-token"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={v?.byo ? 'Saved — paste a new token to replace it' : 'Zone:DNS:Edit token'}
              className="min-w-0 flex-1"
            />
            <Button
              variant="outline"
              disabled={setProvider.isPending || token.trim().length < 20}
              onClick={() => setProvider.mutate({ provider: 'cloudflare', apiToken: token.trim() })}
            >
              Save token
            </Button>
            {v?.byo ? (
              <Button variant="ghost" disabled={setProvider.isPending} onClick={() => setProvider.mutate(null)}>
                Remove
              </Button>
            ) : null}
          </div>
          <p className="text-muted-foreground text-xs">
            Stored only as a Docker secret on the edge — never in the database or the rendered config. Wildcards in a
            swarmy-served zone never use it.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
