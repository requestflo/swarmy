import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import type { DnsZoneView } from './geo-types';

const ANY_REGION = '__any__';

/** "Resolve from <region>" — the exact answer a client there would get. */
export function ResolutionPreviewCard({ zone }: { zone: DnsZoneView }): React.JSX.Element {
  const trpc = useTRPC();
  const [host, setHost] = React.useState('');
  const [region, setRegion] = React.useState(ANY_REGION);
  const [asked, setAsked] = React.useState<{ host: string; region?: string } | null>(null);
  React.useEffect(() => {
    setHost(zone.zone);
    setAsked(null);
  }, [zone.id, zone.zone]);

  const regions = useQuery(trpc.geodns.listRegions.queryOptions());
  const preview = useQuery({
    ...trpc.geodns.previewResolution.queryOptions({
      id: zone.id,
      host: asked?.host ?? zone.zone,
      region: asked?.region,
    }),
    enabled: !!asked,
    refetchOnWindowFocus: false,
  });

  const resolve = (): void => {
    if (host.trim()) {
      setAsked({ host: host.trim(), region: region === ANY_REGION ? undefined : region });
    }
  };

  const p = preview.data;

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Resolution preview</CardTitle>
        <CardDescription>
          Runs the real answering engine against the composed zone — no sockets, exact production
          behaviour.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && resolve()}
            placeholder={`app.${zone.zone}`}
            className="h-8 min-w-40 flex-1"
          />
          <Select value={region} onValueChange={setRegion}>
            <SelectTrigger className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY_REGION}>Anywhere</SelectItem>
              {(regions.data ?? []).map((r) => (
                <SelectItem key={r.region} value={r.region}>
                  {r.region}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button size="sm" variant="outline" onClick={resolve} disabled={!host.trim() || preview.isFetching}>
            {preview.isFetching ? 'Resolving…' : 'Resolve'}
          </Button>
        </div>

        {preview.isError ? <p className="text-status-offline text-xs">{preview.error.message}</p> : null}

        {p ? (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="mono-data text-sm font-medium">{p.host}</span>
              <StatusBadge tone={p.steered ? 'online' : 'neutral'} label={p.steered ? 'steered' : 'unsteered'} />
              {p.degraded ? <StatusBadge tone="warning" label="degraded spill" /> : null}
              {p.rcode !== 'NOERROR' ? <StatusBadge tone="offline" label={p.rcode} /> : null}
            </div>
            {p.answers.length === 0 ? (
              <p className="text-muted-foreground text-sm">No answers.</p>
            ) : (
              <div className="border-border divide-border divide-y rounded-xl border">
                {p.answers.map((a, i) => (
                  <div key={i} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="mono-label w-12 shrink-0">{a.type}</span>
                    <span className="mono-data min-w-0 flex-1 truncate">{a.value}</span>
                    <span className="text-muted-foreground mono-label shrink-0">{a.ttl}s</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-sm">
            Pick a region and resolve a host to see exactly what clients there get.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
