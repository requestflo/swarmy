import * as React from 'react';
import { XIcon } from 'lucide-react';
import { Button, StatusBadge, type StatusTone } from '@swarmy/ui';

interface ServiceInspectorHeaderProps {
  name: string;
  tone: StatusTone;
  status: string;
  stack: string | null;
  onClose: () => void;
}

/** Docked-inspector header: name + live status + stack, with the close affordance. */
export function ServiceInspectorHeader({
  name,
  tone,
  status,
  stack,
  onClose,
}: ServiceInspectorHeaderProps): React.JSX.Element {
  return (
    <div className="border-border flex items-start justify-between gap-3 border-b p-4">
      <div className="min-w-0">
        <p className="font-display truncate text-xl font-bold">{name}</p>
        <p className="mono-label !mb-0 truncate">{stack ?? 'ungrouped'}</p>
        <StatusBadge tone={tone} label={status} className="mt-2" />
      </div>
      <Button variant="ghost" size="icon" className="shrink-0 rounded-full" onClick={onClose} aria-label="Close inspector">
        <XIcon className="size-4" />
      </Button>
    </div>
  );
}
