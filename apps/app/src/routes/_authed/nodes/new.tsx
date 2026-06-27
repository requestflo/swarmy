import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '@/components/page-header';
import { AddNodePanel } from '@/components/onboarding/add-node-panel';

export const Route = createFileRoute('/_authed/nodes/new')({
  component: AddNodePage,
});

function AddNodePage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Add a node"
        title={<>One line. <em>Live</em> in seconds.</>}
        description="Copy the command, paste it on your server, and watch it appear in the swarm."
      />
      <AddNodePanel />
    </div>
  );
}
