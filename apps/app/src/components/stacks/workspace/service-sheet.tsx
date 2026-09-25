import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { XIcon } from 'lucide-react';
import type { InvService } from '@swarmy/core';
import { Button } from '@swarmy/ui';
import { Depth, StatusWord, Tech } from '@/components/calm';
import { STATUS_TONE } from '@/components/canvas/stack-aggregates';
import { stackTone } from '@/components/apps/app-words';
import { serviceRole } from '@/components/canvas/service-role';
import { CopiesStepper } from './copies-stepper';

function copiesSay(s: InvService): string {
  const { running, desired } = s.replicas;
  if (desired === 0) return 'Stopped on purpose: no copies running.';
  if (running >= desired) return desired === 1 ? 'One copy is running.' : `All ${desired} copies are running.`;
  return `${running} of ${desired} copies are running.`;
}

/**
 * The selected part's bottom sheet (ServiceSheet board): what it does and how
 * many copies run; Controls adds the image line and the copies stepper.
 */
export function ServiceSheet({
  stack,
  service,
  onOpen,
  onClose,
}: {
  stack: string;
  service: InvService;
  onOpen: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const tone = stackTone(STATUS_TONE[service.status]);
  return (
    <section
      aria-label={`${service.name} details`}
      className="bg-card border-border absolute inset-x-3 bottom-3 z-10 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-xl border px-4 py-3 shadow-[0_12px_32px_-18px_rgb(0_0_0/0.5)]"
    >
      <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
        <div className="flex items-center gap-2">
          <h3 className="text-[15px] font-semibold">{service.name}</h3>
          <StatusWord tone={tone} />
        </div>
        <p className="text-muted-foreground text-[13px]">
          {serviceRole(service)}. {copiesSay(service)}
        </p>
        <Tech className="truncate">{service.image}</Tech>
      </div>
      <Depth at="controls">
        <CopiesStepper service={service} />
      </Depth>
      <div className="flex items-center gap-2">
        <Button asChild variant="outline" size="sm" className="pointer-coarse:min-h-11">
          <Link to="/stacks/$name/observability" params={{ name: stack }}>Logs</Link>
        </Button>
        <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" onClick={onOpen}>
          Open
        </Button>
        <Button variant="ghost" size="icon" className="size-8 pointer-coarse:size-11" onClick={onClose} aria-label="Close">
          <XIcon className="size-4" />
        </Button>
      </div>
    </section>
  );
}
