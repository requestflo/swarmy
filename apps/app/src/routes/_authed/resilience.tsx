import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { HeartPulseIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/resilience')({
  component: ResiliencePage,
});

function ResiliencePage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Protection · Resilience"
        title={
          <>
            <em>Resilience</em>.
          </>
        }
        description="A score for how well you’d survive failure — problems, fixes and safe drills."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<HeartPulseIcon />}
          title="No score yet"
          description="swarmy checks replicas, backups, topology and drills to score your failure readiness."
        />
      </div>
    </div>
  );
}
