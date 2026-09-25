import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ActivityIcon } from 'lucide-react';
import {
  Switch,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  toast,
} from '@swarmy/ui';
import { useTRPC } from '@/integrations/trpc';

/**
 * Per-stack telemetry opt-in, shown on the stack canvas. State is Docker truth:
 * it reads the `swarmy.otel.enabled` service labels (via `observability.stackTelemetry`)
 * and flips them with `observability.enableForStack` — there is no DB flag. On the
 * next deploy of the stack, OTEL_* env is (un)injected accordingly.
 */
export function OtelStackToggle({ stack }: { stack: string }): React.JSX.Element {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const state = useQuery(trpc.observability.stackTelemetry.queryOptions({ stack }));
  const enabled = state.data?.enabled ?? false;

  const toggle = useMutation(
    trpc.observability.enableForStack.mutationOptions({
      onSuccess: (_data, vars) => {
        toast.success(vars.enabled ? `Telemetry on for ${stack}` : `Telemetry off for ${stack}`);
        void qc.invalidateQueries();
      },
      onError: (e) => toast.error(e.message),
    }),
  );

  const busy = state.isLoading || toggle.isPending;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="bg-card border-border flex h-8 items-center gap-2 rounded-full border px-3 pointer-coarse:h-11">
          <ActivityIcon className="text-muted-foreground size-4" aria-hidden />
          <span className="text-muted-foreground font-mono text-[11.5px]">Telemetry</span>
          <Switch
            checked={enabled}
            disabled={busy}
            onCheckedChange={(v) => toggle.mutate({ stackId: stack, enabled: v })}
            aria-label={`Toggle telemetry for ${stack}`}
          />
        </div>
      </TooltipTrigger>
      <TooltipContent>
        Ship traces &amp; metrics for <span className="mono-data">{stack}</span> to the swarmy
        collector. Applied on the stack&apos;s next deploy.
      </TooltipContent>
    </Tooltip>
  );
}
