import * as React from 'react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface ServiceScaleStepperProps {
  running: number;
  desired: number;
  pending: boolean;
  onScale: (replicas: number) => void;
  /** Heading above the stepper; `null` renders the bare stepper (inside a row). */
  label?: string | null;
  /** Who the copies belong to, for the buttons' accessible names ("web"). */
  name?: string;
}

/** Copies stepper — the quick −/+ (running/desired in the middle). */
export function ServiceScaleStepper({
  running,
  desired,
  pending,
  onScale,
  label = 'Copies',
  name,
}: ServiceScaleStepperProps): React.JSX.Element {
  const of = name ? ` of ${name}` : '';
  const stepper = (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="icon"
        className="size-8 pointer-coarse:size-11"
        disabled={pending || desired <= 0}
        onClick={() => onScale(Math.max(0, desired - 1))}
        aria-label={`One fewer copy${of}`}
      >
        <MinusIcon className="size-4" />
      </Button>
      <span className="mono-data min-w-12 text-center text-base tabular-nums" aria-live="polite">
        {running}/{desired}
      </span>
      <Button
        variant="outline"
        size="icon"
        className="size-8 pointer-coarse:size-11"
        disabled={pending}
        onClick={() => onScale(desired + 1)}
        aria-label={`One more copy${of}`}
      >
        <PlusIcon className="size-4" />
      </Button>
    </div>
  );
  if (label === null) return stepper;
  return (
    <div>
      <p className="mono-label">{label}</p>
      <div className="mt-2">{stepper}</div>
    </div>
  );
}
