import * as React from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { SirenIcon } from 'lucide-react';
import { EmptyState } from '@swarmy/ui';
import { PageHeader } from '@/components/page-header';

export const Route = createFileRoute('/_authed/incidents')({
  component: IncidentsPage,
});

function IncidentsPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-[1600px] px-6 pt-8 lg:pb-20 xl:px-10">
      <PageHeader
        eyebrow="Operations · Incidents"
        title={
          <>
            <em>Incidents</em>.
          </>
        }
        description="Open and past incidents with a full timeline — what fired, what swarmy did, when it resolved."
      />
      <div className="card-pop p-2">
        <EmptyState
          icon={<SirenIcon />}
          title="No incidents"
          description="When something breaks, the full story — detection to resolution — is recorded here."
        />
      </div>
    </div>
  );
}
