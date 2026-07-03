import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';

interface NodeActionsProps {
  nodeId: string;
}

/**
 * PageHeader action for the node page — just the one coral CTA (break-glass
 * node shell). Drain/activate/remove live in the consolidated Controls panel
 * below, not duplicated up here.
 */
export function NodeActions({ nodeId }: NodeActionsProps): React.JSX.Element {
  return (
    <Button asChild size="sm" className="font-bold">
      <Link to="/nodes/$nodeId/terminal" params={{ nodeId }}>
        <TerminalIcon className="size-4" /> Node shell
      </Link>
    </Button>
  );
}
