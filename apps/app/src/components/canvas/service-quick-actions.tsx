import * as React from 'react';
import { useNavigate } from '@tanstack/react-router';
import { RotateCwIcon, SquareArrowOutUpRightIcon, SquareTerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface ServiceQuickActionsProps {
  serviceId: string;
  restarting: boolean;
  onRestart: () => void;
}

/** Restart + jump-to links (service page, terminal) for the docked inspector. */
export function ServiceQuickActions({ serviceId, restarting, onRestart }: ServiceQuickActionsProps): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="grid grid-cols-2 gap-2">
      <Button variant="outline" disabled={restarting} onClick={onRestart}>
        <RotateCwIcon className="size-4" /> Restart
      </Button>
      <Button
        variant="outline"
        onClick={() => navigate({ to: '/services/$serviceId', params: { serviceId } })}
      >
        <SquareArrowOutUpRightIcon className="size-4" /> Open service page
      </Button>
      <Button
        variant="outline"
        className="col-span-2"
        onClick={() => navigate({ to: '/services/$serviceId/terminal', params: { serviceId } })}
      >
        <SquareTerminalIcon className="size-4" /> Terminal
      </Button>
    </div>
  );
}
