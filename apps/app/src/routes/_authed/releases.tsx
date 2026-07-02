import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { RocketIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/releases')({
  component: ReleasesPage,
});

function ReleasesPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Delivery · Releases"
        title={
          <>
            <em>Releases</em>.
          </>
        }
        description="Every deploy, snapshotted — health gates, compose diffs and one-click rollback."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<RocketIcon />}
          title="No releases yet"
          description="Deploy a stack and every release is snapshotted here with health gates and rollback."
        />
      </div>
    </div>
  );
}
