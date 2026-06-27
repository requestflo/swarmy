import * as React from 'react';
import { Link } from '@tanstack/react-router';
import { TerminalIcon } from 'lucide-react';
import { Button, Card, CardContent, EmptyState } from '@swarmy/ui';

interface ServiceLogsPanelProps {
  serviceId: string;
}

/**
 * Logs surface. Live output streams over the controller from the node agent;
 * the empty state sells the next action — opening an exec terminal on the node.
 */
export function ServiceLogsPanel({ serviceId }: ServiceLogsPanelProps): React.JSX.Element {
  return (
    <Card className="card-pop mt-6 border-0">
      <CardContent className="p-6">
        <EmptyState
          icon={<TerminalIcon />}
          title="No logs yet"
          description="Live output streams from the node agent over the controller. Open a terminal to tail and exec into a running replica."
          action={
            <Button asChild className="rounded-full font-bold">
              <Link to="/services/$serviceId/terminal" params={{ serviceId }}>
                <TerminalIcon className="size-4" /> Open terminal
              </Link>
            </Button>
          }
        />
      </CardContent>
    </Card>
  );
}
