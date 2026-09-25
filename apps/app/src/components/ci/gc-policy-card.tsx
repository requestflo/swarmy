import * as React from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  toast,
} from '@swarmy/ui';
import { QuietSwitch } from '@/components/rowpage/row-page';
import { useTRPC } from '@/integrations/trpc';

type GcMode = 'on-healthcheck' | 'age-days';

interface GcPolicy {
  mode: GcMode;
  keepProd: boolean;
  days: number | null;
  cacheMaxAgeDays?: number;
  cacheMaxGb?: number;
}

interface GcPolicyCardProps {
  value: GcPolicy | undefined;
  onDone: () => void;
}

/** Image GC policy editor. Preserves the original mutation + scoped invalidation. */
export function GcPolicyCard({ value, onDone }: GcPolicyCardProps): React.JSX.Element {
  const trpc = useTRPC();
  const [mode, setMode] = React.useState<GcMode>(value?.mode ?? 'on-healthcheck');
  const [keepProd, setKeepProd] = React.useState(value?.keepProd ?? true);
  const [days, setDays] = React.useState(value?.days ?? 14);
  const [cacheDays, setCacheDays] = React.useState(value?.cacheMaxAgeDays ?? 14);
  const [cacheGb, setCacheGb] = React.useState(value?.cacheMaxGb ?? 20);

  React.useEffect(() => {
    if (value) {
      setMode(value.mode);
      setKeepProd(value.keepProd);
      setDays(value.days ?? 14);
      setCacheDays(value.cacheMaxAgeDays ?? 14);
      setCacheGb(value.cacheMaxGb ?? 20);
    }
  }, [value]);

  const save = useMutation(
    trpc.cicd.setGcPolicy.mutationOptions({
      onSuccess: () => {
        toast.success('GC policy saved');
        onDone();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="calm-card border-0">
      <CardHeader>
        <CardTitle className="text-base">Image GC</CardTitle>
        <CardDescription>Reclaim disk — but never delete a digest that's running in prod.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="mono-label">Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as GcMode)}>
            <SelectTrigger aria-label="Mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on-healthcheck">Promote on healthcheck</SelectItem>
              <SelectItem value="age-days">Older than N days</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {mode === 'age-days' && (
          <div className="grid gap-1.5">
            <Label className="mono-label">Keep days</Label>
            <Input type="number" value={days} onChange={(e) => setDays(Number(e.target.value))} />
          </div>
        )}
        <div className="bg-accent/40 flex items-center justify-between rounded-xl px-4 py-3">
          <div>
            <Label className="font-medium">Keep prod images</Label>
            <p className="text-muted-foreground text-xs">Pin every digest running in prod. Recommended.</p>
          </div>
          <QuietSwitch aria-label="Keep prod images" checked={keepProd} onCheckedChange={setKeepProd} />
        </div>
        <div className="grid gap-1.5">
          <Label className="mono-label">Build cache</Label>
          <p className="text-muted-foreground text-xs">
            Builds reuse layers cached in your registry. Old or excess cache is removed; the next build is just slower.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1">
              <Label className="text-muted-foreground text-xs" htmlFor="gc-cache-days">
                Unused for (days)
              </Label>
              <Input id="gc-cache-days" type="number" min={1} value={cacheDays} onChange={(e) => setCacheDays(Number(e.target.value))} />
            </div>
            <div className="grid gap-1">
              <Label className="text-muted-foreground text-xs" htmlFor="gc-cache-gb">
                Keep at most (GB)
              </Label>
              <Input id="gc-cache-gb" type="number" min={1} value={cacheGb} onChange={(e) => setCacheGb(Number(e.target.value))} />
            </div>
          </div>
        </div>
        <Button
          variant="outline"
          onClick={() =>
            save.mutate({
              mode,
              keepProd,
              days: mode === 'age-days' ? days : null,
              cacheMaxAgeDays: Math.max(1, Math.round(cacheDays)),
              cacheMaxGb: Math.max(1, Math.round(cacheGb)),
            })
          }
          disabled={save.isPending}
        >
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}
