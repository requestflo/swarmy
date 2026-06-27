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
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

type GcMode = 'on-healthcheck' | 'age-days';

interface GcPolicy {
  mode: GcMode;
  keepProd: boolean;
  days: number | null;
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

  React.useEffect(() => {
    if (value) {
      setMode(value.mode);
      setKeepProd(value.keepProd);
      setDays(value.days ?? 14);
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
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Image GC</CardTitle>
        <CardDescription>Reclaim disk — but never delete a digest that's running in prod.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-1.5">
          <Label className="mono-label">Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as GcMode)}>
            <SelectTrigger>
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
          <Switch checked={keepProd} onCheckedChange={setKeepProd} />
        </div>
        <Button
          variant="outline"
          onClick={() => save.mutate({ mode, keepProd, days: mode === 'age-days' ? days : null })}
          disabled={save.isPending}
        >
          Save policy
        </Button>
      </CardContent>
    </Card>
  );
}
