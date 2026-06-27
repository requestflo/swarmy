import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  Input,
  Label,
  cn,
  toast,
} from '@swarmy/ui';
import { LayersIcon } from 'lucide-react';
import { useTRPC } from '@/integrations/trpc';

const TEMPLATE_IDS = ['postgres-ha', 'redis-ha'] as const;
type TemplateId = (typeof TEMPLATE_IDS)[number];

/** Ready-made HA templates: pick one, fill the form, one Deploy across regions. */
export function TemplatesGallery(): React.JSX.Element {
  const trpc = useTRPC();
  const templates = useQuery(trpc.templates.list.queryOptions());
  const [selected, setSelected] = React.useState<TemplateId | null>(null);

  const items = templates.data ?? [];

  return (
    <Card className="card-pop mt-6 border-0">
      <CardHeader>
        <CardTitle className="text-base">HA templates</CardTitle>
        <CardDescription>
          One form, one Deploy. swarmy fills in placement + anti-affinity across regions. Every
          template stores its compose so the exact stack runs without swarmy.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        {items.length === 0 ? (
          <EmptyState
            icon={<LayersIcon />}
            title="No templates available"
            description="HA templates ship with swarmy — check back once the registry is populated."
            className="border-0 sm:col-span-2"
          />
        ) : (
          items.map((t) => {
            const isSelected = selected === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected(t.id as TemplateId)}
                aria-pressed={isSelected}
                className={cn(
                  'card-pop-hover rounded-2xl border p-4 text-left transition-colors',
                  isSelected && 'bg-accent border-primary/40 ring-primary/30 ring-1',
                )}
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
            );
          })
        )}
      </CardContent>
      {selected && <TemplatePreview id={selected} />}
    </Card>
  );
}

function TemplatePreview({ id }: { id: TemplateId }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
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

  const deploy = useMutation(
    trpc.templates.deploy.mutationOptions({
      onSuccess: (r) => {
        toast.success(
          `Deployed ${name} across ${regions.length} region(s)` +
            (r.geoRecords ? ` · ${r.geoRecords} Geo-DNS record(s) wired` : ''),
        );
        qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <CardContent className="border-t pt-6">
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
          <Button
            onClick={() => deploy.mutate({ id, params: { name, regions } })}
            disabled={deploy.isPending || !name || regions.length === 0}
          >
            Deploy across {regions.length} region{regions.length === 1 ? '' : 's'}
          </Button>
        </div>
      )}
    </CardContent>
  );
}
