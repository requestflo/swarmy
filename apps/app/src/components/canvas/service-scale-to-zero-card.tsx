import * as React from 'react';
import { MoonIcon, ZapIcon } from 'lucide-react';
import { Button, Switch } from '@swarmy/ui';

interface ServiceScaleToZeroCardProps {
  enabled: boolean;
  idleSeconds: number;
  asleep: boolean;
  loading: boolean;
  pending: boolean;
  wakePending: boolean;
  onToggle: (v: boolean) => void;
  onWake: () => void;
}

/** Scale-to-zero card: sleep/wake toggle + a one-tap wake when the service is asleep. */
export function ServiceScaleToZeroCard({
  enabled,
  idleSeconds,
  asleep,
  loading,
  pending,
  wakePending,
  onToggle,
  onWake,
}: ServiceScaleToZeroCardProps): React.JSX.Element {
  return (
    <div className="border-border rounded-xl border p-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold">
            <MoonIcon className="text-status-progress size-4" /> Scale to zero
          </p>
          <p className="text-muted-foreground text-xs">
            Sleeps after {idleSeconds}s idle · wakes on the next request
          </p>
        </div>
        <Switch
          checked={enabled}
          disabled={pending || loading}
          onCheckedChange={(v) => {
            // Defense-in-depth: only ever write on a real user toggle — never on
            // mount, a re-render, or a 4s refetch echoing the current value.
            if (v === enabled || pending || loading) return;
            onToggle(v);
          }}
        />
      </div>
      {asleep && (
        <Button className="mt-3 w-full" disabled={wakePending} onClick={onWake}>
          <ZapIcon className="size-4" /> Wake now
        </Button>
      )}
    </div>
  );
}
