import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { DeployStrategyView } from '@swarmy/core';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Switch,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

function strategySummary(s: DeployStrategyView | null): string {
  if (!s) return 'Rolling update (default)';
  if (s.type === 'canary') {
    return `Canary — ${s.trafficPct ?? 10}% traffic for ${s.durationMin ?? 15}m`;
  }
  if (s.type === 'bluegreen') return `Blue/green — old stack kept ${s.durationMin ?? 30}m`;
  return 'Rolling update';
}

/**
 * Per-stack deploy-safety settings. Writes the `swarmy.deploy.safety` label on
 * the stack (Docker truth) — the deploy-safety worker then watches every new
 * release for the window and rolls back automatically if asked to.
 */
export function SafetyCard({ stackName }: { stackName: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const safety = useQuery({
    ...trpc.releases.getSafety.queryOptions({ stackName }),
    refetchInterval: 15_000,
  });

  const [enabled, setEnabled] = React.useState(false);
  const [windowSec, setWindowSec] = React.useState(120);
  const [autoRollback, setAutoRollback] = React.useState(false);
  const [dirty, setDirty] = React.useState(false);

  React.useEffect(() => {
    if (safety.data && !dirty) {
      setEnabled(safety.data.enabled);
      setWindowSec(safety.data.windowSec);
      setAutoRollback(safety.data.autoRollback);
    }
  }, [safety.data, dirty]);

  const save = useMutation(
    trpc.releases.setSafety.mutationOptions({
      onSuccess: () => {
        toast.success('Deploy safety updated');
        setDirty(false);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  return (
    <Card className="card-pop border-0">
      <CardHeader>
        <CardTitle className="text-base">Deploy safety</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p className="text-muted-foreground -mt-2 text-sm">
          Watch every new release and judge it against the stack's health. Stored on the stack
          itself, so it survives anything.
        </p>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">Health gate</Label>
            <p className="text-muted-foreground text-xs">Hold "deploying" until the stack proves healthy.</p>
          </div>
          <Switch
            checked={enabled}
            onCheckedChange={(v) => {
              setEnabled(v);
              setDirty(true);
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">Watch window</Label>
            <p className="text-muted-foreground text-xs">Seconds to observe before judging (30–3600).</p>
          </div>
          <Input
            type="number"
            min={30}
            max={3600}
            value={windowSec}
            disabled={!enabled}
            onChange={(e) => {
              setWindowSec(Number(e.target.value));
              setDirty(true);
            }}
            className="w-24 text-right font-mono"
          />
        </div>

        <div className="flex items-center justify-between gap-4">
          <div>
            <Label className="text-sm font-medium">Auto-rollback</Label>
            <p className="text-muted-foreground text-xs">
              Gate fails → redeploy the last healthy release automatically.
            </p>
          </div>
          <Switch
            checked={autoRollback}
            disabled={!enabled}
            onCheckedChange={(v) => {
              setAutoRollback(v);
              setDirty(true);
            }}
          />
        </div>

        <div className="flex items-center justify-between gap-4 border-t pt-4">
          <div>
            <Label className="text-sm font-medium">Strategy</Label>
            <p className="text-muted-foreground text-xs">{strategySummary(safety.data?.strategy ?? null)}</p>
          </div>
          <Link to="/stacks" className="text-primary text-xs font-semibold hover:underline">
            Configure on deploy →
          </Link>
        </div>

        <Button
          variant="outline"
          disabled={!dirty || save.isPending || (enabled && (windowSec < 30 || windowSec > 3600))}
          onClick={() => save.mutate({ stackName, enabled, windowSec, autoRollback })}
        >
          {save.isPending ? 'Saving…' : 'Save safety settings'}
        </Button>
      </CardContent>
    </Card>
  );
}
