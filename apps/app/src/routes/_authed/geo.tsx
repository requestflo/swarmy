import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  StatusBadge,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';
import { PageHeader } from '@/components/page-header';
import { CountUp } from '@/components/count-up';

export const Route = createFileRoute('/_authed/geo')({
  component: GeoPage,
});

const TEMPLATE_IDS = ['postgres-ha', 'redis-ha'] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

function GeoPage(): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  // NOTE: `trpc.geodns` / `trpc.templates` resolve once the routers are mounted
  // in root.ts (see INTEGRATION). Until then these are the only type errors.
  const config = useQuery(trpc.geodns.getConfig.queryOptions());
  const records = useQuery(trpc.geodns.listRecords.queryOptions());
  const nodes = useQuery(trpc.nodes.list.queryOptions());
  const preview = useQuery({
    ...trpc.geodns.previewZone.queryOptions(),
    enabled: !!config.data?.enabled,
  });

  const invalidate = () => qc.invalidateQueries();
  const onErr = (e: { message: string }) => toast.error(e.message);

  const setEnabled = useMutation(
    trpc.geodns.setEnabled.mutationOptions({ onSuccess: invalidate, onError: onErr }),
  );
  const setConfig = useMutation(
    trpc.geodns.setConfig.mutationOptions({
      onSuccess: () => {
        toast.success('Zone config saved');
        invalidate();
      },
      onError: onErr,
    }),
  );
  const setNodeRegion = useMutation(
    trpc.geodns.setNodeRegion.mutationOptions({
      onSuccess: () => {
        toast.success('Region assigned');
        invalidate();
      },
      onError: onErr,
    }),
  );
  const removeRecord = useMutation(
    trpc.geodns.removeRecord.mutationOptions({ onSuccess: invalidate, onError: onErr }),
  );

  const enabled = !!config.data?.enabled;
  const recordCount = records.data?.length ?? 0;
  const [zone, setZone] = React.useState('');
  const [ttl, setTtl] = React.useState(30);
  React.useEffect(() => {
    if (config.data) {
      setZone(config.data.zone);
      setTtl(config.data.ttl);
    }
  }, [config.data]);

  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Geo-DNS"
        title={
          recordCount > 0 ? (
            <>
              <CountUp value={recordCount} /> record{recordCount === 1 ? '' : 's'} <em>steered</em>.
            </>
          ) : (
            <>
              Closest healthy region, <em>always</em>.
            </>
          )
        }
        description="Authoritative Geo-DNS (CoreDNS) routes each visitor to the nearest healthy regional ingress — and drains away from a region that goes dark."
        actions={
          <StatusBadge tone={enabled ? 'online' : 'neutral'} label={enabled ? 'CoreDNS · live' : 'Off'} />
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Zone</CardTitle>
            <CardDescription>
              Enabling deploys CoreDNS as a managed swarm service and starts answering for this zone.
              DNS failover is soft (resolver caching) — low TTL biases new clients toward healthy regions.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-5">
            <div className="grid gap-1.5">
              <Label className="mono-label">Zone</Label>
              <Input value={zone} onChange={(e) => setZone(e.target.value)} placeholder="geo.example.com" />
            </div>
            <div className="grid gap-1.5">
              <Label className="mono-label">TTL (seconds)</Label>
              <Input
                type="number"
                min={10}
                max={120}
                value={ttl}
                onChange={(e) => setTtl(Number(e.target.value))}
              />
            </div>
            <Button onClick={() => setConfig.mutate({ zone, ttl })} disabled={setConfig.isPending || !zone}>
              Save zone
            </Button>
            <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
              <div>
                <Label htmlFor="geo-on" className="font-medium">
                  Enabled
                </Label>
                <p className="text-muted-foreground text-xs">Deploys / removes the CoreDNS service.</p>
              </div>
              <Switch
                id="geo-on"
                checked={enabled}
                onCheckedChange={(v) => setEnabled.mutate({ enabled: v })}
              />
            </div>
          </CardContent>
        </Card>

        <Card className="card-pop border-0">
          <CardHeader>
            <CardTitle className="text-base">Rendered zone preview</CardTitle>
            <CardDescription>The Corefile + zonefile the agent would apply.</CardDescription>
          </CardHeader>
          <CardContent>
            {!enabled ? (
              <div className="text-muted-foreground flex h-40 flex-col items-center justify-center gap-2 text-center text-sm">
                <span className="mono-label">Off</span>
                <p>Enable Geo-DNS to render the zone.</p>
              </div>
            ) : preview.data ? (
              <pre className="bg-muted mono-data max-h-64 overflow-auto rounded-xl p-4 text-xs">
                {preview.data.summary}
                {'\n\n'}
                {preview.data.files.map((f) => `# ${f.path}\n${f.contents}`).join('\n')}
              </pre>
            ) : (
              <p className="text-muted-foreground text-sm">No preview.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="text-base">Node regions</CardTitle>
          <CardDescription>
            Region is the <code className="mono-data">swarmy.region</code> label — pushed to the Swarm
            engine so placement constraints work even without swarmy.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <div className="border-t">
            {(nodes.data ?? []).map((n) => (
              <NodeRegionRow
                key={n.id}
                node={n}
                onSet={(region) => setNodeRegion.mutate({ nodeId: n.id, region })}
              />
            ))}
            {nodes.data?.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No nodes yet. Add one, then give it a region.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card className="card-pop mt-6 border-0">
        <CardHeader>
          <CardTitle className="flex items-center justify-between text-base">
            Records
            <AddRecordDialog onDone={invalidate} />
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[1fr_auto] gap-x-4 px-6 pb-2 sm:grid-cols-[2fr_1fr_1.5fr_auto_auto]">
            <span className="mono-label">Host</span>
            <span className="mono-label hidden sm:block">Region</span>
            <span className="mono-label hidden sm:block">Target ingress</span>
            <span className="mono-label hidden sm:block">Health</span>
            <span className="mono-label text-right">{recordCount > 0 ? recordCount : ''}</span>
          </div>
          <div className="border-t">
            {(records.data ?? []).map((r) => (
              <div
                key={r.id}
                className="hover:bg-accent/60 grid grid-cols-[1fr_auto] items-center gap-x-4 border-b px-6 py-3 transition-colors last:border-b-0 sm:grid-cols-[2fr_1fr_1.5fr_auto_auto]"
              >
                <div className="min-w-0">
                  <p className="mono-data truncate font-medium">{r.host}</p>
                  <p className="text-muted-foreground mono-label sm:hidden">
                    {r.region} · {r.targetIngress}
                  </p>
                </div>
                <span className="hidden sm:block">
                  <Badge variant="muted">{r.region}</Badge>
                </span>
                <span className="mono-data hidden truncate sm:block">{r.targetIngress}</span>
                <span className="hidden sm:block">
                  <StatusBadge tone={r.healthy ? 'online' : 'offline'} label={r.healthy ? 'healthy' : 'down'} />
                </span>
                <div className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => removeRecord.mutate({ id: r.id })}>
                    <Trash2Icon className="size-4" />
                  </Button>
                </div>
              </div>
            ))}
            {records.data?.length === 0 && (
              <div className="text-muted-foreground px-6 py-12 text-center text-sm">
                No records yet. Map a host to a regional ingress.
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <TemplatesGallery />
    </div>
  );
}

function NodeRegionRow({
  node,
  onSet,
}: {
  node: { id: string; name: string; hostname: string };
  onSet: (region: string) => void;
}) {
  const [region, setRegion] = React.useState('');
  return (
    <div className="hover:bg-accent/60 flex items-center gap-3 border-b px-6 py-3 transition-colors last:border-b-0">
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{node.name}</p>
        <p className="text-muted-foreground mono-label truncate">{node.hostname}</p>
      </div>
      <Input
        value={region}
        onChange={(e) => setRegion(e.target.value)}
        placeholder="us-east"
        className="max-w-40"
      />
      <Button size="sm" onClick={() => onSet(region)} disabled={!region}>
        Set region
      </Button>
    </div>
  );
}

function AddRecordDialog({ onDone }: { onDone: () => void }) {
  const trpc = useTRPC();
  const [open, setOpen] = React.useState(false);
  const [host, setHost] = React.useState('');
  const [region, setRegion] = React.useState('');
  const [target, setTarget] = React.useState('');

  const add = useMutation(
    trpc.geodns.upsertRecord.mutationOptions({
      onSuccess: () => {
        toast.success('Record saved');
        setOpen(false);
        setHost('');
        setRegion('');
        setTarget('');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <PlusIcon className="size-4" /> Add record
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Map a host to a regional ingress</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="mono-label">Host</Label>
            <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="app.geo.example.com" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Region</Label>
            <Input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="us-east" />
          </div>
          <div className="grid gap-1.5">
            <Label className="mono-label">Target ingress (IP or hostname)</Label>
            <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="203.0.113.10" />
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={() => add.mutate({ host, region, targetIngress: target })}
            disabled={add.isPending || !host || !region || !target}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TemplatesGallery(): React.JSX.Element {
  const trpc = useTRPC();
  const templates = useQuery(trpc.templates.list.queryOptions());
  const [selected, setSelected] = React.useState<TemplateId | null>(null);

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">HA templates</CardTitle>
        <CardDescription>
          One form, one Deploy. swarmy fills in placement + anti-affinity across regions. Every template
          stores its compose so the exact stack runs without swarmy.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {(templates.data ?? []).map((t) => (
          <button
            key={t.id}
            onClick={() => setSelected(t.id as TemplateId)}
            className="card-pop-hover rounded-2xl border p-4 text-left"
          >
            <div className="flex items-center justify-between">
              <span className="font-semibold">{t.title}</span>
              <Badge variant="muted">{t.engine}</Badge>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">{t.blurb}</p>
            <p className="text-muted-foreground mono-label mt-2">
              recommended: {t.recommendedRegions}+ regions
            </p>
          </button>
        ))}
        {templates.data?.length === 0 && (
          <p className="text-muted-foreground text-sm">No templates available.</p>
        )}
      </CardContent>
      {selected && <TemplatePreview id={selected} />}
    </Card>
  );
}

function TemplatePreview({ id }: { id: TemplateId }): React.JSX.Element {
  const trpc = useTRPC();
  const [name, setName] = React.useState('my-db');
  const [regionsText, setRegionsText] = React.useState('us-east, eu-west, ap-south');
  const regions = regionsText
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const preview = useQuery({
    ...trpc.templates.preview.queryOptions({ id, params: { name, regions } }),
    enabled: !!name && regions.length > 0,
  });

  return (
    <CardContent className="border-t pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label className="mono-label">Name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Regions (comma-separated)</Label>
          <Input value={regionsText} onChange={(e) => setRegionsText(e.target.value)} />
        </div>
      </div>
      {preview.data && (
        <div className="mt-4 grid gap-3">
          <div className="bg-accent/40 rounded-xl px-4 py-3 text-sm">
            <p className="font-medium">{preview.data.connectionHint}</p>
            <p className="text-muted-foreground mt-1 text-xs">{preview.data.durabilityNote}</p>
          </div>
          <pre className="bg-muted mono-data max-h-72 overflow-auto rounded-xl p-4 text-xs">
            {preview.data.composeSource}
          </pre>
        </div>
      )}
    </CardContent>
  );
}
