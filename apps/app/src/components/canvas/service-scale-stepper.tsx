import * as React from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface ServiceScaleStepperProps {
  running: number;
  desired: number;
  pending: boolean;
  onScale: (replicas: number) => void;
}

/** Replica scale stepper — the quick +/- used inside the docked inspector. */
export function ServiceScaleStepper({ running, desired, pending, onScale }: ServiceScaleStepperProps): React.JSX.Element {
  return (
    <div>
      <p className="mono-label">Replicas</p>
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="outline"
          size="icon"
          disabled={pending || desired <= 0}
          onClick={() => onScale(Math.max(0, desired - 1))}
          aria-label="Scale down"
        >
          <MinusIcon className="size-4" />
        </Button>
        <span className="mono-data text-2xl tabular-nums">
          {running}/{desired}
        </span>
        <Button variant="outline" size="icon" disabled={pending} onClick={() => onScale(desired + 1)} aria-label="Scale up">
          <PlusIcon className="size-4" />
        </Button>
      </div>
    </div>
  );
}
