import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { LayoutTemplateIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/blueprints')({
  component: BlueprintsPage,
});

function BlueprintsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Deploy · Blueprints"
        title={
          <>
            <em>Blueprints</em>.
          </>
        }
        description="Production-ready app stacks — database, cache, buckets, routes and backups wired in one deploy."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<LayoutTemplateIcon />}
          title="Gallery coming soon"
          description="One-click, production-ready stacks — pick a blueprint, name it, deploy."
        />
      </div>
    </div>
  );
}
