import * as React from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ServerIcon } from 'lucide-react';
import { Button } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';
import { AddNodeFlow } from '@/components/onboarding/add-node-flow';

export const Route = createFileRoute('/_authed/nodes/new')({
  component: AddNodePage,
});

function AddNodePage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Add a node"
        title={
          <>
            One line. <em>Live</em> in seconds.
          </>
        }
        description="Copy the command, paste it on your server, and watch it appear in the swarm."
        actions={
          <Button asChild variant="outline">
            <Link to="/nodes">
              <ServerIcon className="size-4" /> View cluster
            </Link>
          </Button>
        }
      />
      <AddNodeFlow />
    </div>
  );
}
