import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { PauseIcon, PlayIcon, TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface NodeActionsProps {
  nodeId: string;
  draining: boolean;
  activating: boolean;
  onDrain: () => void;
  onActivate: () => void;
}

/**
 * Node action cluster for the PageHeader. One coral CTA (the break-glass node
 * shell); drain/activate stay quiet outline toggles. All three preserve their
 * original wiring.
 */
export function NodeActions({
  nodeId,
  draining,
  activating,
  onDrain,
  onActivate,
}: NodeActionsProps): React.JSX.Element {
  return (
    <>
      <Button variant="outline" size="sm" onClick={onDrain} disabled={draining}>
        <PauseIcon className="size-4" /> Drain
      </Button>
      <Button variant="outline" size="sm" onClick={onActivate} disabled={activating}>
        <PlayIcon className="size-4" /> Activate
      </Button>
      {/* Node shell (break-glass host access) — gated by org policy +
          SWARMY_ALLOW_NODE_SHELL on the agent. Lands on the dedicated
          /nodes/$nodeId/terminal route. */}
      <Button asChild size="sm" className="font-bold">
        <Link to="/nodes/$nodeId/terminal" params={{ nodeId }}>
          <TerminalIcon className="size-4" /> Node shell
        </Link>
      </Button>
    </>
  );
}
